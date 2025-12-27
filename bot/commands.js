/**
 * bot/commands.js
 *
 * Centralized command handler (switch/case) for incoming messages.
 * Exports:
 * - handleOutgoingCommand(sock, meta, messageOrText)
 *
 * Conventions:
 * - prefix configurable (default '.')
 * - supports basic commands as example (help, ping, info)
 *
 * NOTE: messageOrText can be either:
 * - an object representing a Baileys message (incoming), or
 * - a text string (when triggered via API)
 */

const PREFIX = ".";

export async function handleOutgoingCommand(sock, meta, messageOrText) {
  // Helper to send text messages
  async function sendText(jid, text) {
    try {
      await sock.sendMessage(jid, { text });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  }

  // Normalize input
  let text = "";
  let from = null;
  if (typeof messageOrText === "string") {
    text = messageOrText.trim();
    from = `${meta.phoneNumber}@s.whatsapp.net`; // default destination if none provided
  } else if (messageOrText?.key?.remoteJid) {
    from = messageOrText.key.remoteJid;
    // extract text bodies
    const content = messageOrText.message;
    if (content.conversation) text = content.conversation;
    else if (content.extendedTextMessage?.text) text = content.extendedTextMessage.text;
    else text = "";
  } else {
    // unknown shape
    return { ok: false, error: "Unsupported message format" };
  }

  if (!text || !text.startsWith(PREFIX)) {
    // Not a command; ignore or implement auto-responses
    return { ok: false, ignored: true };
  }

  const args = text.slice(PREFIX.length).trim().split(/\s+/);
  const command = args.shift().toLowerCase();

  switch (command) {
    case "ping":
      return await sendText(from, "pong");
    case "help":
      return await sendText(from, "CRAZY MINI Help:\n.commands:\n.ping - pong\n.help - this message\n.info - session info");
    case "info":
      return await sendText(from, `Session: ${meta.id}\nPhone: ${meta.phoneNumber}\nOwner: ${meta.ownerUserId}`);
    case "echo":
      return await sendText(from, args.join(" "));
    default:
      return await sendText(from, `Unknown command: ${command}\nUse ${PREFIX}help`);
  }
}

export default { handleOutgoingCommand };
