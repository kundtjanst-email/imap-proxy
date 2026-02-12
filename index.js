import express from 'express';
import cors from 'cors';
import { ImapFlow } from 'imapflow';
import nodemailer from 'nodemailer';

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Auth middleware - verify proxy secret
const PROXY_SECRET = process.env.PROXY_SECRET;
function authMiddleware(req, res, next) {
  if (!PROXY_SECRET) return next(); // Skip if not configured (dev mode)
  const secret = req.headers['x-proxy-secret'];
  if (secret !== PROXY_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// Health check (no auth required)
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// Apply auth to all API routes
app.use('/api', authMiddleware);

// Helper to parse email addresses
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

// Decode a MIME part body based on Content-Transfer-Encoding
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

// Extract the best body (prefer HTML, fallback to plain text) from raw MIME source
function extractBodyFromSource(raw) {
  // Check for multipart boundary
  const boundaryMatch = raw.match(/boundary="?([^";\r\n]+)"?/i);
  if (!boundaryMatch) {
    // Not multipart - simple message
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

    // Handle nested multipart (e.g. multipart/alternative inside multipart/mixed)
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

    if (partHeaders.includes("text/html")) {
      htmlBody = decoded;
    } else if (partHeaders.includes("text/plain")) {
      textBody = decoded;
    }
  }

  return htmlBody || textBody || "";
}

// Main IMAP/SMTP handler
app.post('/api/:action', async (req, res) => {
  try {
    const { action } = req.params;
    const {
      imap_host,
      imap_port,
      imap_username,
      imap_password,
      smtp_host,
      smtp_port,
      smtp_username,
      smtp_password,
      email,
      display_name,
      use_ssl,
      ...params
    } = req.body;

    // Validate required credentials
    if (!imap_host || !imap_username || !imap_password) {
      return res.status(400).json({ error: "Missing IMAP credentials" });
    }

    // LIST messages
    if (action === "list") {
      const maxResults = params.maxResults || 20;
      const client = new ImapFlow({
        host: imap_host,
        port: imap_port || 993,
        secure: use_ssl !== false,
        auth: {
          user: imap_username,
          pass: imap_password,
        },
        logger: false,
      });

      await client.connect();
      try {
        const lock = await client.getMailboxLock("INBOX");
        try {
      const msgs = [];

          // Fetch messages with source for snippet extraction
          for await (const msg of client.fetch({ all: true }, {
            envelope: true,
            uid: true,
            flags: true,
            bodyStructure: true,
            source: { start: 0, maxLength: 4096 }, // Fetch first 4KB for snippet
          })) {
            const env = msg.envelope;
            let snippet = "";
            if (msg.source) {
              try {
                const body = extractBodyFromSource(msg.source.toString());
                // Strip HTML tags for snippet
                const plain = body.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
                snippet = plain.substring(0, 200);
              } catch { /* ignore */ }
            }
            msgs.push({
              id: String(msg.uid),
              threadId: env.messageId || String(msg.uid),
              snippet,
              from: parseAddress(env.from),
              subject: env.subject || "",
              date: env.date ? env.date.toISOString() : new Date().toISOString(),
              labelIds: [],
              isUnread: !msg.flags.has("\\Seen"),
            });
          }

          // Sort newest first, then take only maxResults
          msgs.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
          return res.json({ messages: msgs.slice(0, maxResults) });
        } finally {
          lock.release();
        }
      } finally {
        await client.logout();
      }
    }

    // GET single message
    if (action === "get") {
      const { messageId } = params;
      if (!messageId) {
        return res.status(400).json({ error: "messageId is required" });
      }

      const client = new ImapFlow({
        host: imap_host,
        port: imap_port || 993,
        secure: use_ssl !== false,
        auth: {
          user: imap_username,
          pass: imap_password,
        },
        logger: false,
      });

      await client.connect();
      try {
        const lock = await client.getMailboxLock("INBOX");
        try {
          const msg = await client.fetchOne(messageId, {
            envelope: true,
            source: true,
            uid: true,
            flags: true,
          }, { uid: true });

          const env = msg.envelope;
          let body = "";

          if (msg.source) {
            body = extractBodyFromSource(msg.source.toString());
          }

          return res.json({
            id: String(msg.uid),
            threadId: env.messageId || String(msg.uid),
            from: parseAddress(env.from),
            to: parseAddressList(env.to),
            subject: env.subject || "",
            date: env.date ? env.date.toISOString() : new Date().toISOString(),
            body,
            labelIds: [],
          });
        } finally {
          lock.release();
        }
      } finally {
        await client.logout();
      }
    }

    // SEND email
    if (action === "send") {
      const { to, subject, body, inReplyTo } = params;
      if (!to || !subject) {
        return res.status(400).json({ error: "to and subject are required" });
      }

      const transporter = nodemailer.createTransport({
        host: smtp_host,
        port: smtp_port || 465,
        secure: smtp_port === 465,
        auth: {
          user: smtp_username || email,
          pass: smtp_password || imap_password,
        },
      });

      const mailOptions = {
        from: display_name
          ? `"${display_name}" <${email}>`
          : email,
        to,
        subject,
        text: body,
      };

      if (inReplyTo) {
        mailOptions.inReplyTo = inReplyTo;
        mailOptions.references = inReplyTo;
      }

      const info = await transporter.sendMail(mailOptions);
      return res.json({ success: true, id: info.messageId });
    }

    // MARK READ
    if (action === "markRead") {
      const { messageId } = params;
      if (!messageId) {
        return res.status(400).json({ error: "messageId is required" });
      }

      const client = new ImapFlow({
        host: imap_host,
        port: imap_port || 993,
        secure: use_ssl !== false,
        auth: {
          user: imap_username,
          pass: imap_password,
        },
        logger: false,
      });

      await client.connect();
      try {
        const lock = await client.getMailboxLock("INBOX");
        try {
          await client.messageFlagsAdd(messageId, ["\\Seen"], { uid: true });
          return res.json({ success: true });
        } finally {
          lock.release();
        }
      } finally {
        await client.logout();
      }
    }

    // MARK UNREAD
    if (action === "markUnread") {
      const { messageId } = params;
      if (!messageId) {
        return res.status(400).json({ error: "messageId is required" });
      }

      const client = new ImapFlow({
        host: imap_host,
        port: imap_port || 993,
        secure: use_ssl !== false,
        auth: {
          user: imap_username,
          pass: imap_password,
        },
        logger: false,
      });

      await client.connect();
      try {
        const lock = await client.getMailboxLock("INBOX");
        try {
          await client.messageFlagsRemove(messageId, ["\\Seen"], { uid: true });
          return res.json({ success: true });
        } finally {
          lock.release();
        }
      } finally {
        await client.logout();
      }
    }

    // LIST LABELS (folders)
    if (action === "listLabels") {
      const client = new ImapFlow({
        host: imap_host,
        port: imap_port || 993,
        secure: use_ssl !== false,
        auth: {
          user: imap_username,
          pass: imap_password,
        },
        logger: false,
      });

      await client.connect();
      try {
        const mailboxes = await client.list();
        const labels = mailboxes.map((mb) => ({
          id: mb.path,
          name: mb.name,
          type: "user",
        }));
        return res.json({ labels });
      } finally {
        await client.logout();
      }
    }

    // MODIFY LABELS (move message)
    if (action === "modifyLabels") {
      const { messageId, addLabelIds } = params;
      if (!messageId) {
        return res.status(400).json({ error: "messageId is required" });
      }

      if (addLabelIds && addLabelIds.length > 0) {
        const client = new ImapFlow({
          host: imap_host,
          port: imap_port || 993,
          secure: use_ssl !== false,
          auth: {
            user: imap_username,
            pass: imap_password,
          },
          logger: false,
        });

        await client.connect();
        try {
          const lock = await client.getMailboxLock("INBOX");
          try {
            await client.messageMove(messageId, addLabelIds[0], { uid: true });
            return res.json({ success: true });
          } finally {
            lock.release();
          }
        } finally {
          await client.logout();
        }
      }

      return res.json({ success: true });
    }

    return res.status(400).json({ error: "Unknown action" });
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Unknown error";
    console.error("Proxy error:", msg, error?.responseText || error?.response || '');
    return res.status(500).json({
      error: msg,
      detail: error?.responseText || error?.code || undefined,
    });
  }
});

app.listen(PORT, () => {
  console.log(`IMAP Proxy running on port ${PORT}`);
});
