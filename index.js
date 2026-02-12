import express from 'express';
import cors from 'cors';
import { ImapFlow } from 'imapflow';
import nodemailer from 'nodemailer';

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

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

app.post('/api/:action', async (req, res) => {
  try {
    const { action } = req.params;
    const {
      imap_host, imap_port, imap_username, imap_password,
      smtp_host, smtp_port, smtp_username, smtp_password,
      email, display_name, use_ssl, ...params
    } = req.body;

    if (!imap_host || !imap_username || !imap_password) {
      return res.status(400).json({ error: "Missing IMAP credentials" });
    }

    if (action === "list") {
      const maxResults = params.maxResults || 20;
      const client = new ImapFlow({ host: imap_host, port: imap_port || 993, secure: use_ssl !== false, auth: { user: imap_username, pass: imap_password }, logger: false });
      await client.connect();
      try {
        const lock = await client.getMailboxLock("INBOX");
        try {
          const msgs = [];
          let count = 0;
          for await (const msg of client.fetch({ all: true }, { envelope: true, uid: true, flags: true })) {
            if (count >= maxResults) break;
            const env = msg.envelope;
            msgs.push({ id: String(msg.uid), threadId: env.messageId || String(msg.uid), snippet: env.subject?.substring(0, 100) || "", from: parseAddress(env.from), subject: env.subject || "", date: env.date ? env.date.toISOString() : new Date().toISOString(), labelIds: [], isUnread: !msg.flags.has("\\Seen") });
            count++;
          }
          msgs.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
          return res.json({ messages: msgs.slice(0, maxResults) });
        } finally { lock.release(); }
      } finally { await client.logout(); }
    }

    if (action === "get") {
      const { messageId } = params;
      if (!messageId) return res.status(400).json({ error: "messageId is required" });
      const client = new ImapFlow({ host: imap_host, port: imap_port || 993, secure: use_ssl !== false, auth: { user: imap_username, pass: imap_password }, logger: false });
      await client.connect();
      try {
        const lock = await client.getMailboxLock("INBOX");
        try {
          const msg = await client.fetchOne(messageId, { envelope: true, source: true, uid: true, flags: true }, { uid: true });
          const env = msg.envelope;
          let body = "";
          if (msg.source) {
            const raw = msg.source.toString();
            const bodyStart = raw.indexOf("\r\n\r\n");
            if (bodyStart !== -1) {
              body = raw.substring(bodyStart + 4);
              if (raw.toLowerCase().includes("content-transfer-encoding: base64")) {
                try { body = Buffer.from(body.replace(/\\s/g, ""), "base64").toString("utf-8"); } catch {}
              } else if (raw.toLowerCase().includes("content-transfer-encoding: quoted-printable")) {
                body = body.replace(/=\r\n/g, "").replace(/=([0-9A-Fa-f]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
              }
            }
          }
          return res.json({ id: String(msg.uid), threadId: env.messageId || String(msg.uid), from: parseAddress(env.from), to: parseAddressList(env.to), subject: env.subject || "", date: env.date ? env.date.toISOString() : new Date().toISOString(), body, labelIds: [] });
        } finally { lock.release(); }
      } finally { await client.logout(); }
    }

    if (action === "send") {
      const { to, subject, body, inReplyTo } = params;
      if (!to || !subject) return res.status(400).json({ error: "to and subject are required" });
      const transporter = nodemailer.createTransport({ host: smtp_host, port: smtp_port || 465, secure: smtp_port === 465, auth: { user: smtp_username || email, pass: smtp_password || imap_password } });
      const mailOptions = { from: display_name ? `"${display_name}" <${email}>` : email, to, subject, text: body };
      if (inReplyTo) { mailOptions.inReplyTo = inReplyTo; mailOptions.references = inReplyTo; }
      const info = await transporter.sendMail(mailOptions);
      return res.json({ success: true, id: info.messageId });
    }

    if (action === "markRead") {
      const { messageId } = params;
      if (!messageId) return res.status(400).json({ error: "messageId is required" });
      const client = new ImapFlow({ host: imap_host, port: imap_port || 993, secure: use_ssl !== false, auth: { user: imap_username, pass: imap_password }, logger: false });
      await client.connect();
      try { const lock = await client.getMailboxLock("INBOX"); try { await client.messageFlagsAdd(messageId, ["\\Seen"], { uid: true }); return res.json({ success: true }); } finally { lock.release(); } } finally { await client.logout(); }
    }

    if (action === "markUnread") {
      const { messageId } = params;
      if (!messageId) return res.status(400).json({ error: "messageId is required" });
      const client = new ImapFlow({ host: imap_host, port: imap_port || 993, secure: use_ssl !== false, auth: { user: imap_username, pass: imap_password }, logger: false });
      await client.connect();
      try { const lock = await client.getMailboxLock("INBOX"); try { await client.messageFlagsRemove(messageId, ["\\Seen"], { uid: true }); return res.json({ success: true }); } finally { lock.release(); } } finally { await client.logout(); }
    }

    if (action === "listLabels") {
      const client = new ImapFlow({ host: imap_host, port: imap_port || 993, secure: use_ssl !== false, auth: { user: imap_username, pass: imap_password }, logger: false });
      await client.connect();
      try { const mailboxes = await client.list(); return res.json({ labels: mailboxes.map((mb) => ({ id: mb.path, name: mb.name, type: "user" })) }); } finally { await client.logout(); }
    }

    if (action === "modifyLabels") {
      const { messageId, addLabelIds } = params;
      if (!messageId) return res.status(400).json({ error: "messageId is required" });
      if (addLabelIds && addLabelIds.length > 0) {
        const client = new ImapFlow({ host: imap_host, port: imap_port || 993, secure: use_ssl !== false, auth: { user: imap_username, pass: imap_password }, logger: false });
        await client.connect();
        try { const lock = await client.getMailboxLock("INBOX"); try { await client.messageMove(messageId, addLabelIds[0], { uid: true }); return res.json({ success: true }); } finally { lock.release(); } } finally { await client.logout(); }
      }
      return res.json({ success: true });
    }

    return res.status(400).json({ error: "Unknown action" });
  } catch (error) {
    console.error("Proxy error:", error);
    return res.status(500).json({ error: error instanceof Error ? error.message : "Unknown error" });
  }
});

app.listen(PORT, () => { console.log(`IMAP Proxy running on port ${PORT}`); });
