import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { useMultiFileAuthState, makeWASocket, /*requestPairingCode*/ DisconnectReason } from "@whiskeysockets/baileys";
import { format } from "date-fns";

/**
 * createPairing - starts a pairing sequence for a specific sessionId
 * Emits events through the provided Socket.IO namespace
 *
 * Parameters object:
 * - sessionId
 * - folder: auth state folder
 * - phoneNumber
 * - ownerUserId
 * - namespace: Socket.IO Namespace instance (io.of(`/pair/${sessionId}`))
 * - db: LowDB instance (optional) - we update status there
 * - runtimeSessions: Map to register runtime socket
 * - handleOutgoingCommand: function to pass into connected runtime
 */
export async function createPairing({ sessionId, folder, phoneNumber, ownerUserId, namespace, db, runtimeSessions, handleOutgoingCommand }) {
  // Ensure folder exists
  fs.mkdirSync(folder, { recursive: true });

  namespace.on("connection", (socket) => {
    console.log(`[pair:${sessionId}] client connected ${socket.id}`);
  });

  try {
    // create auth state
    const { state, saveCreds } = await useMultiFileAuthState(folder);

    // create socket
    const sock = makeWASocket({
      auth: state,
      printQRInTerminal: false,
      logger: undefined
    });

    // Register runtime
    runtimeSessions.set(sessionId, { sock, meta: { sessionId, folder, phoneNumber, ownerUserId }, sockRef: sock });

    // listen for pairing code using official helper
    try {
      const pairing = await requestPairingCode({ sock, phoneNumber }); // note: the signature might be requestPairingCode(sock, number) depending on version
      // pairing expected: { pairingCode, ttl } - adapt if different
      const pairingCode = pairing?.pairingCode ?? pairing?.code ?? null;
      const ttl = pairing?.ttl ?? null;
      namespace.emit("pairing.code", { pairingCode, ttl });
      // Store to DB
      if (db) {
        await db.read();
        const meta = db.data.sessionsMeta.find(s => s.id === sessionId);
        if (meta) {
          meta.pairingCode = pairingCode;
          meta.status = "pairing";
          meta.pairingCreatedAt = new Date().toISOString();
          await db.write();
        }
      }
    } catch (e) {
      console.warn(`[pair:${sessionId}] requestPairingCode error`, e);
      namespace.emit("pairing.error", { message: "Pairing code generation failed", details: String(e) });
    }

    // Watch events
    sock.ev.on("connection.update", async (update) => {
      // update may contain { connection, lastDisconnect, qr, paired, isNewLogin }
      namespace.emit("pairing.update", update);
      // Save creds on credentials update
      if (update.connection === "close" && update.lastDisconnect) {
        const reason = update.lastDisconnect.error?.output?.statusCode || update.lastDisconnect.error?.message || update.lastDisconnect.error;
        namespace.emit("pairing.closed", { reason });
        // detect known disconnect reasons
        if (update.lastDisconnect?.error?.output?.statusCode) {
          // noop
        }
        // Mark DB
        if (db) {
          await db.read();
          const meta = db.data.sessionsMeta.find(s => s.id === sessionId);
          if (meta) {
            meta.status = "disconnected";
            meta.disconnectedAt = new Date().toISOString();
            await db.write();
          }
        }
      }
      if (update.connection === "open") {
        namespace.emit("pairing.connected", { info: update });
        // mark as connected in DB
        if (db) {
          await db.read();
          const meta = db.data.sessionsMeta.find(s => s.id === sessionId);
          if (meta) {
            meta.status = "connected";
            meta.connectedAt = new Date().toISOString();
            await db.write();
          }
        }
        // Register message handler
        sock.ev.on("messages.upsert", async (m) => {
          try {
            const messages = m.messages ?? (Array.isArray(m) ? m : []);
            for (const message of messages) {
              // ignore status messages or from self
              if (!message.message) continue;
              // pass to command handler
              await handleOutgoingCommand(sock, { id: sessionId, ownerUserId, phoneNumber }, message);
            }
          } catch (err) {
            console.error(`[pair:${sessionId}] message handler error`, err);
          }
        });

        // Save creds whenever updated
        sock.ev.on("creds.update", saveCreds);
      }
    });

    // Save credentials on start if any
    sock.ev.on("creds.update", saveCreds);

    // Keep a watcher for disconnect to update DB and cleanup
    sock.ev.on("connection.update", async (update) => {
      if (update.connection === "close") {
        // Try to figure out if the disconnection is recoverable
        const lastDisconnect = update.lastDisconnect || {};
        const reason = lastDisconnect.error?.output?.payload?.reason || lastDisconnect.error?.message || "unknown";
        console.log(`[pair:${sessionId}] closed connection, reason:`, reason);
        // Save state to DB
        if (db) {
          await db.read();
          const meta = db.data.sessionsMeta.find(s => s.id === sessionId);
          if (meta) {
            if (reason && String(reason).toLowerCase().includes("bad session")) {
              meta.status = "failed";
              meta.failedAt = new Date().toISOString();
            } else {
              meta.status = "disconnected";
              meta.disconnectedAt = new Date().toISOString();
            }
            await db.write();
          }
        }
        // cleanup runtime
        runtimeSessions.delete(sessionId);
      }
    });

    // Return socket for further use
    return sock;
  } catch (err) {
    console.error(`[pair:${sessionId}] pairing error:`, err);
    namespace.emit("pairing.error", { message: "Internal pairing error", details: String(err) });
    // Update DB if provided
    if (db) {
      await db.read();
      const meta = db.data.sessionsMeta.find(s => s.id === sessionId);
      if (meta) {
        meta.status = "failed";
        meta.failedAt = new Date().toISOString();
        await db.write();
      }
    }
    throw err;
  }
}
