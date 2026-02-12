import express from 'express';
import cors from 'cors';
import { ImapFlow } from 'imapflow';
import nodemailer from 'nodemailer';

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

const PROXY_SECRET = process.env.PROXY_SECRET;
function authMiddleware(req, res, next) {
  if (!PROXY_SECRET) return next();
  const secret = req.headers['x-proxy-secret'];
  if (secret !== PROXY_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.use('/api', authMiddleware);

const transporterCache = new Map();
const TRANSPORTER_TTL = 5 * 60 * 1000;

function getTransporter(smtpHost, smtpPort, smtpUser, smtpPass, displayName, email) {
  const cacheKey = `${smtpHost}:${smtpPort}:${smtpUser}`;
  const cached = transporterCache.get(cacheKey);
  if (cached && Date.now() - cached.created < TRANSPORTER_TTL) {
    return cached.transporter;
  }
  if (cached) {
    try { cached.transporter.close(); } catch {}
    transporterCache.delete(cacheKey);
  }
  const transporter = nodemailer.createTransport({
    host: smtpHost,
    port: smtpPort || 465,
    secure: (smtpPort || 465) === 465,
    pool: true,
    maxConnections: 3,
    maxMessages: 50,
    connectionTimeout: 15000,
    greetingTimeout: 10000,
    socketTimeout: 30000,
    auth: { user: smtpUser, pass: smtpPass },
  });
  transporterCache.set(cacheKey, { transporter, created: Date.now() });
  return transporter;
}

function parseAddress(addr) {
  if (!addr || !addr.length) return "";
  const a = addr[0];
  if (a.name) return `${a.name} <${a.address}>`;
  return a.address || "";
}

function parseAddressList(addr) {
  if (!addr || !addr.length) return "";
  return addr.map((a) => (a.name ? `${a.name} <${a.address}>` : a.address || "")).join(", ");
}

function decodePart(content, encoding) {
  if (!encoding) return content;
  encoding = encoding.toLowerCase().trim();
  if (encoding === "base64") {
    try {
      return Buffer.from(content.replace(/\s/g, ""), "base64").toString("utf-8");
    } catch { return content; }
  }
  if (encoding === "quoted-printable") {
    return content
      .replace(/=\r?\n/g, "")
      .replace(/=([0-9A-Fa-f]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
  }
  return content;
}

function extractBodyFromSource(raw) {
  const boundaryMatch = raw.match(/boundary="?([^";\r\n]+)"?/i);
  if (!boundaryMatch) {
    const bodyStart = raw.indexOf("\r\n\r\n");
    if (bodyStart === -1) return "";
    const headerSection = raw.substring(0, bodyStart).toLowerCase();
    const body = raw.substring(bodyStart + 4);
    const encMatch = headerSection.match(/content-transfer-encoding:\s*(\S+)/i);
    return decodePart(body, encMatch?.[1] || "").trim();
  }
  const boundary = boundaryMatch[1].trim();
  const parts = raw.split("--" + boundary);
  let htmlBody = "";
  let textBody = "";
  for (const part of parts) {
    if (part.startsWith("--") || !part.trim()) continue;
    const partHeaderEnd = part.indexOf("\r\n\r\n");
    if (partHeaderEnd === -1) continue;
    const partHeaders = part.substring(0, partHeaderEnd).toLowerCase();
    const partContent = part.substring(partHeaderEnd + 4).replace(/--$/, "").trim();
    const nestedBoundaryMatch = partHeaders.match(/boundary="?([^";\r\n]+)"?/i);
    if (nestedBoundaryMatch) {
      const nested = extractBodyFromSource(part.substring(partHeaderEnd + 4));
      if (nested) {
        if (!htmlBody && nested.includes("<")) htmlBody = nested;
        else if (!textBody) textBody = nested;
      }
      continue;
    }
    const encMatch = partHeaders.match(/content-transfer-encoding:\s*(\S+)/);
    const decoded = decodePart(partContent, encMatch?.[1] || "");
    if (partHeaders.includes("text/html")) htmlBody = decoded;
    else if (partHeaders.includes("text/plain")) textBody = decoded;
  }
  return htmlBody || textBody || "";
}

function createImapClient(host, port, username, password, useSsl) {
  return new ImapFlow({
    host,
    port: port || 993,
    secure: useSsl !== false,
    auth: { user: username, pass: password },
    logger: false,
  });
}

app.post('/api/:action', async (req, res) => {
  try {
    const { action } = req.params;
    const {
      imap_host, imap_port, imap_username, imap_password,
      smtp_host, smtp_port, smtp_username, smtp_password,
      email, display_name, use_ssl,
      ...params
    } = req.body;

    if (!imap_host || !imap_username || !imap_password) {
      return res.status(400).json({ error: "Missing IMAP credentials" });
    }

    if (action === "send") {
      const { to, subject, body, inReplyTo, attachments } = params;
      if (!to || !subject) {
        return res.status(400).json({ error: "to and subject are required" });
      }
      const transporter = getTransporter(
        smtp_host, smtp_port,
        smtp_username || email,
        smtp_password || imap_password,
        display_name, email
      );
      const mailOptions = {
        from: display_name ? `"${display_name}" <${email}>` : email,
        to,
        subject,
        text: body,
      };
      if (attachments && attachments.length > 0) {
        mailOptions.attachments = attachments.map(att => ({
          filename: att.filename,
          content: att.base64,
          encoding: 'base64',
          contentType: att.mimeType,
        }));
      }
      if (inReplyTo) {
        mailOptions.inReplyTo = inReplyTo;
        mailOptions.references = inReplyTo;
      }
      const info = await transporter.sendMail(mailOptions);
      return res.json({ success: true, id: info.messageId });
    }

    if (action === "list") {
      const maxResults = params.maxResults || 20;
      const client = createImapClient(imap_host, imap_port, imap_username, imap_password, use_ssl);
      await client.connect();
      try {
        const lock = await client.getMailboxLock("INBOX");
        try {
          const msgs = [];
          for await (const msg of client.fetch({ all: true }, {
            envelope: true, uid: true, flags: true, bodyStructure: true,
            source: { start: 0, maxLength: 4096 },
          })) {
            const env = msg.envelope;
            let snippet = "";
            if (msg.source) {
              try {
                const b = extractBodyFromSource(msg.source.toString());
                snippet = b.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().substring(0, 200);
              } catch {}
            }
            msgs.push({
              id: String(msg.uid), threadId: env.messageId || String(msg.uid),
              snippet, from: parseAddress(env.from), subject: env.subject || "",
              date: env.date ? env.date.toISOString() : new Date().toISOString(),
              labelIds: [], isUnread: !msg.flags.has("\\Seen"),
            });
          }
          msgs.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
          return res.json({ messages: msgs.slice(0, maxResults) });
        } finally { lock.release(); }
      } finally { await client.logout(); }
    }

    if (action === "get") {
      const { messageId } = params;
      if (!messageId) return res.status(400).json({ error: "messageId is required" });
      const client = createImapClient(imap_host, imap_port, imap_username, imap_password, use_ssl);
      await client.connect();
      try {
        const lock = await client.getMailboxLock("INBOX");
        try {
          const msg = await client.fetchOne(messageId, {
            envelope: true, source: true, uid: true, flags: true,
          }, { uid: true });
          const env = msg.envelope;
          let body = "";
          if (msg.source) body = extractBodyFromSource(msg.source.toString());
          return res.json({
            id: String(msg.uid), threadId: env.messageId || String(msg.uid),
            from: parseAddress(env.from), to: parseAddressList(env.to),
            subject: env.subject || "",
            date: env.date ? env.date.toISOString() : new Date().toISOString(),
            body, labelIds: [],
          });
        } finally { lock.release(); }
      } finally { await client.logout(); }
    }

    if (action === "markRead") {
      const { messageId } = params;
      if (!messageId) return res.status(400).json({ error: "messageId is required" });
      const client = createImapClient(imap_host, imap_port, imap_username, imap_password, use_ssl);
      await client.connect();
      try {
        const lock = await client.getMailboxLock("INBOX");
        try {
          await client.messageFlagsAdd(messageId, ["\\Seen"], { uid: true });
          return res.json({ success: true });
        } finally { lock.release(); }
      } finally { await client.logout(); }
    }

    if (action === "markUnread") {
      const { messageId } = params;
      if (!messageId) return res.status(400).json({ error: "messageId is required" });
      const client = createImapClient(imap_host, imap_port, imap_username, imap_password, use_ssl);
      await client.connect();
      try {
        const lock = await client.getMailboxLock("INBOX");
        try {
          await client.messageFlagsRemove(messageId, ["\\Seen"], { uid: true });
          return res.json({ success: true });
        } finally { lock.release(); }
      } finally { await client.logout(); }
    }

    if (action === "listLabels") {
      const client = createImapClient(imap_host, imap_port, imap_username, imap_password, use_ssl);
      await client.connect();
      try {
        const mailboxes = await client.list();
        const labels = mailboxes.map((mb) => ({ id: mb.path, name: mb.name, type: "user" }));
        return res.json({ labels });
      } finally { await client.logout(); }
    }

    if (action === "modifyLabels") {
      const { messageId, addLabelIds } = params;
      if (!messageId) return res.status(400).json({ error: "messageId is required" });
      if (addLabelIds && addLabelIds.length > 0) {
        const client = createImapClient(imap_host, imap_port, imap_username, imap_password, use_ssl);
        await client.connect();
        try {
          const lock = await client.getMailboxLock("INBOX");
          try {
            await client.messageMove(messageId, addLabelIds[0], { uid: true });
            return res.json({ success: true });
          } finally { lock.release(); }
        } finally { await client.logout(); }
      }
      return res.json({ success: true });
    }

    return res.status(400).json({ error: "Unknown action" });
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Unknown error";
    console.error("Proxy error:", msg, error?.responseText || error?.response || '');
    return res.status(500).json({ error: msg, detail: error?.responseText || error?.code || undefined });
  }
});

app.listen(PORT, () => {
  console.log(`IMAP Proxy running on port ${PORT}`);
});
