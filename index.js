const express = require("express");
const axios = require("axios");
const app = express();

app.use(express.json());

// ─────────────────────────────────────────
// CONFIG
// ─────────────────────────────────────────
const VERIFY_TOKEN = "myWebhookToken123";

const SFMC = {
  clientId:     "tiszxupfs23rdz6lxq42nd4y",
  clientSecret: "kuSX70VSplkUlDVKSjmqvwfk",
  subdomain:    "mcpn9815n8n8wcj-xnx5frlx03bq",
  deExternalKey:"WebhookDE"
};

// ─────────────────────────────────────────
// LOGGER UTILITY
// ─────────────────────────────────────────
function log(level, section, message, data = null) {
  const timestamp = new Date().toISOString();
  const icons = { INFO: "ℹ️", SUCCESS: "✅", ERROR: "❌", WARN: "⚠️", DEBUG: "🔍" };
  const icon = icons[level] || "📌";
  const line = `[${timestamp}] ${icon} [${section}] ${message}`;
  console.log(line);
  if (data) {
    console.log("    └─ Data:", JSON.stringify(data, null, 2));
  }
}

// ─────────────────────────────────────────
// TOKEN CACHE
// ─────────────────────────────────────────
let tokenCache = {
  value: null,
  expiresAt: null
};

async function getSFMCToken() {
  const now = Date.now();

  if (tokenCache.value && tokenCache.expiresAt && now < tokenCache.expiresAt - 60000) {
    const remainingMs = tokenCache.expiresAt - now;
    log("INFO", "TOKEN", `Using cached token (expires in ${Math.round(remainingMs / 1000)}s)`);
    return tokenCache.value;
  }

  log("INFO", "TOKEN", "No valid cached token — fetching new one from SFMC...");

  try {
    const url = `https://${SFMC.subdomain}.auth.marketingcloudapis.com/v2/token`;
    log("DEBUG", "TOKEN", `POST ${url}`);

    const response = await axios.post(url, {
      grant_type:    "client_credentials",
      client_id:     SFMC.clientId,
      client_secret: SFMC.clientSecret
    });

    tokenCache.value     = response.data.access_token;
    tokenCache.expiresAt = now + response.data.expires_in * 1000;

    log("SUCCESS", "TOKEN", `New token cached successfully (expires in ${response.data.expires_in}s)`);
    return tokenCache.value;

  } catch (err) {
    log("ERROR", "TOKEN", "Failed to fetch SFMC token", {
      status:  err.response?.status,
      message: err.response?.data || err.message
    });
    throw err;
  }
}

// ─────────────────────────────────────────
// SFMC: Save Row to Data Extension
// ─────────────────────────────────────────
async function saveToDE({ from, eventType, content, messageId, timestamp }) {
  log("INFO", "SFMC", `Attempting to save row to DE: ${SFMC.deExternalKey}`, {
    from, eventType, content, messageId, timestamp
  });

  try {
    const token = await getSFMCToken();
    const url   = `https://${SFMC.subdomain}.rest.marketingcloudapis.com/hub/v1/dataevents/key:${SFMC.deExternalKey}/rowset`;

    const payload = [{
      keys:   { MessageId: messageId },
      values: {
        PhoneNumber: from,
        EventType:   eventType,
        Content:     content,
        MessageId:   messageId,
        Timestamp:   timestamp
      }
    }];

    log("DEBUG", "SFMC", `POST ${url}`);
    log("DEBUG", "SFMC", "Payload being sent", payload);

    const response = await axios.post(url, payload, {
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json"
      }
    });

    log("SUCCESS", "SFMC", `Row saved to DE successfully`, {
      httpStatus: response.status,
      eventType,
      from,
      content
    });

  } catch (err) {
    log("ERROR", "SFMC", "Failed to save row to DE", {
      httpStatus:   err.response?.status,
      errorDetails: err.response?.data || err.message
    });

    if (err.response?.status === 401) {
      log("WARN", "SFMC", "401 Unauthorized — clearing token cache for next retry");
      tokenCache = { value: null, expiresAt: null };
    }

    if (err.response?.status === 404) {
      log("WARN", "SFMC", `404 Not Found — check if DE External Key "${SFMC.deExternalKey}" is correct`);
    }

    if (err.response?.status === 400) {
      log("WARN", "SFMC", "400 Bad Request — check DE field names match exactly (case-sensitive)");
    }
  }
}

// ─────────────────────────────────────────
// WEBHOOK: Verification (GET)
// ─────────────────────────────────────────
app.get("/webhook", (req, res) => {
  log("INFO", "VERIFY", "Webhook verification request received", {
    mode:  req.query["hub.mode"],
    token: req.query["hub.verify_token"]
  });

  const mode      = req.query["hub.mode"];
  const token     = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    log("SUCCESS", "VERIFY", "Webhook verified successfully! Sending challenge back.");
    return res.status(200).send(challenge);
  }

  log("ERROR", "VERIFY", "Verification failed — token mismatch or wrong mode", {
    expectedToken: VERIFY_TOKEN,
    receivedToken: token,
    mode
  });
  return res.sendStatus(403);
});

// ─────────────────────────────────────────
// WEBHOOK: Receive Events (POST)
// ─────────────────────────────────────────
app.post("/webhook", async (req, res) => {
  const body = req.body;

  log("INFO", "WEBHOOK", "Incoming POST request received");
  log("DEBUG", "WEBHOOK", "Full raw payload", body);

  if (body.object !== "whatsapp_business_account") {
    log("WARN", "WEBHOOK", `Unexpected object type: "${body.object}" — ignoring`);
    return res.sendStatus(404);
  }

  // Respond to WhatsApp immediately
  res.sendStatus(200);
  log("INFO", "WEBHOOK", "200 OK sent back to WhatsApp");

  try {
    const entries = body.entry || [];
    log("INFO", "WEBHOOK", `Processing ${entries.length} entry/entries`);

    for (const entry of entries) {
      const changes = entry.changes || [];
      log("INFO", "WEBHOOK", `Entry has ${changes.length} change(s)`);

      for (const change of changes) {
        const messages = change.value?.messages || [];
        const statuses = change.value?.statuses || [];

        // Log status updates (delivered, read, etc.) for visibility
        for (const status of statuses) {
          log("INFO", "STATUS", `Message status update`, {
            messageId: status.id,
            status:    status.status,
            to:        status.recipient_id,
            timestamp: new Date(status.timestamp * 1000).toISOString()
          });
        }

        if (messages.length === 0) {
          log("INFO", "WEBHOOK", "No messages in this change — might be a status update only");
          continue;
        }

        log("INFO", "WEBHOOK", `Found ${messages.length} message(s) to process`);

        for (const message of messages) {
          const from      = message.from;
          const messageId = message.id;
          const timestamp = new Date(message.timestamp * 1000).toISOString();

          log("INFO", "MESSAGE", `New message received`, {
            from, messageId, type: message.type, timestamp
          });

          // ── TEXT ──────────────────────────────────
          if (message.type === "text") {
            const text = message.text?.body || "";
            log("INFO", "MESSAGE", `Text message from ${from}: "${text}"`);

            await saveToDE({ from, eventType: "text", content: text, messageId, timestamp });

          // ── REACTION ──────────────────────────────
          } else if (message.type === "reaction") {
            const emoji            = message.reaction?.emoji || "";
            const reactedMessageId = message.reaction?.message_id || messageId;
            log("INFO", "MESSAGE", `Reaction from ${from}: ${emoji} on message ${reactedMessageId}`);

            await saveToDE({ from, eventType: "reaction", content: emoji, messageId: reactedMessageId, timestamp });

          // ── UNSUPPORTED ───────────────────────────
          } else {
            log("WARN", "MESSAGE", `Unhandled message type: "${message.type}" from ${from} — skipping`);
          }
        }
      }
    }

    log("SUCCESS", "WEBHOOK", "All messages processed successfully");

  } catch (err) {
    log("ERROR", "WEBHOOK", "Unexpected error while processing webhook", {
      message: err.message,
      stack:   err.stack
    });
  }
});

// ─────────────────────────────────────────
// SERVER START
// ─────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  log("SUCCESS", "SERVER", `🚀 Server started on port ${PORT}`);
  log("INFO",    "SERVER", `SFMC subdomain   : ${SFMC.subdomain}`);
  log("INFO",    "SERVER", `SFMC DE Key      : ${SFMC.deExternalKey}`);
  log("INFO",    "SERVER", `Verify Token     : ${VERIFY_TOKEN}`);
});










// const express = require("express");
// const axios = require("axios");
// const app = express();

// app.use(express.json());

// // ─────────────────────────────────────────
// // CONFIG
// // ─────────────────────────────────────────
// const VERIFY_TOKEN = "myWebhookToken123";

// const SFMC = {
//   clientId:     "tiszxupfs23rdz6lxq42nd4y",
//   clientSecret: "kuSX70VSplkUlDVKSjmqvwfk",
//   subdomain:    "mcpn9815n8n8wcj-xnx5frlx03bq",        // e.g. mc563885gzs27c5t9-63k636ttgm
//   deExternalKey:"WebhookDE"
// };


// // ─────────────────────────────────────────
// // TOKEN CACHE — avoids fetching on every message
// // ─────────────────────────────────────────
// let tokenCache = {
//   value: null,
//   expiresAt: null
// };

// async function getSFMCToken() {
//   const now = Date.now();

//   // Return cached token if still valid (with 60s buffer)
//   if (tokenCache.value && tokenCache.expiresAt && now < tokenCache.expiresAt - 60000) {
//     return tokenCache.value;
//   }

//   console.log("🔑 Fetching new SFMC token...");
//   const url = `https://${SFMC.subdomain}.auth.marketingcloudapis.com/v2/token`;

//   const response = await axios.post(url, {
//     grant_type:    "client_credentials",
//     client_id:     SFMC.clientId,
//     client_secret: SFMC.clientSecret
//   });

//   tokenCache.value     = response.data.access_token;
//   tokenCache.expiresAt = now + response.data.expires_in * 1000; // expires_in is in seconds

//   console.log(`✅ New token cached, expires in ${response.data.expires_in}s`);
//   return tokenCache.value;
// }

// // ─────────────────────────────────────────
// // SFMC: Save Row to Data Extension
// // ─────────────────────────────────────────
// async function saveToDE({ from, eventType, content, messageId, timestamp }) {
//   try {
//     const token = await getSFMCToken();
//     const url   = `https://${SFMC.subdomain}.rest.marketingcloudapis.com/hub/v1/dataevents/key:${SFMC.deExternalKey}/rowset`;

//     const payload = [{
//       keys: {
//         MessageId: messageId   // MessageId as Primary Key — unique per event
//       },
//       values: {
//         PhoneNumber: from,
//         EventType:   eventType,   // "text" or "reaction"
//         Content:     content,     // message text or emoji
//         MessageId:   messageId,
//         Timestamp:   timestamp    // ISO string e.g. 2025-02-20T10:30:00.000Z
//       }
//     }];

//     await axios.post(url, payload, {
//       headers: {
//         Authorization: `Bearer ${token}`,
//         "Content-Type": "application/json"
//       }
//     });

//     console.log(`✅ Saved to DE | Type: ${eventType} | From: ${from} | Content: ${content}`);

//   } catch (err) {
//     const errDetail = err.response?.data || err.message;
//     console.error("❌ Failed to save to DE:", JSON.stringify(errDetail, null, 2));

//     // If token expired mid-session, clear cache so it refreshes next time
//     if (err.response?.status === 401) {
//       console.warn("⚠️ Token may have expired — clearing cache for next retry");
//       tokenCache = { value: null, expiresAt: null };
//     }
//   }
// }

// // ─────────────────────────────────────────
// // WEBHOOK: Verification (GET)
// // ─────────────────────────────────────────
// app.get("/webhook", (req, res) => {
//   const mode      = req.query["hub.mode"];
//   const token     = req.query["hub.verify_token"];
//   const challenge = req.query["hub.challenge"];

//   if (mode === "subscribe" && token === VERIFY_TOKEN) {
//     console.log("✅ Webhook verified!");
//     return res.status(200).send(challenge);
//   }

//   console.warn("❌ Webhook verification failed");
//   return res.sendStatus(403);
// });

// // ─────────────────────────────────────────
// // WEBHOOK: Receive Events (POST)
// // ─────────────────────────────────────────
// app.post("/webhook", async (req, res) => {
//   const body = req.body;

//   // Only handle WhatsApp Business events
//   if (body.object !== "whatsapp_business_account") {
//     return res.sendStatus(404);
//   }

//   // Respond to WhatsApp immediately — never keep them waiting
//   res.sendStatus(200);

//   // Process asynchronously after responding
//   try {
//     for (const entry of body.entry || []) {
//       for (const change of entry.changes || []) {
//         const messages = change.value?.messages || [];

//         for (const message of messages) {
//           const from      = message.from;
//           const messageId = message.id;
//           const timestamp = new Date(message.timestamp * 1000).toISOString();

//           // ── TEXT MESSAGE ──────────────────────────
//           if (message.type === "text") {
//             const text = message.text?.body || "";
//             console.log(`📩 Text from ${from}: "${text}"`);

//             await saveToDE({
//               from,
//               eventType: "text",
//               content:   text,
//               messageId,
//               timestamp
//             });

//           // ── REACTION ─────────────────────────────
//           } else if (message.type === "reaction") {
//             const emoji            = message.reaction?.emoji || "";
//             const reactedMessageId = message.reaction?.message_id || messageId;
//             console.log(`😀 Reaction from ${from}: ${emoji}`);

//             await saveToDE({
//               from,
//               eventType: "reaction",
//               content:   emoji,
//               messageId: reactedMessageId,
//               timestamp
//             });

//           // ── OTHER TYPES ───────────────────────────
//           } else {
//             console.log(`📎 Skipped unhandled type: "${message.type}" from ${from}`);
//           }
//         }
//       }
//     }
//   } catch (err) {
//     console.error("❌ Error processing webhook:", err.message);
//   }
// });

// // ─────────────────────────────────────────
// const PORT = process.env.PORT || 3000;
// app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));














// const express = require("express");
// const app = express();

// app.use(express.json());

// const VERIFY_TOKEN = "myWebhookToken123"; // change this

// // ✅ Webhook Verification (GET)
// app.get("/webhook", (req, res) => {
//   const mode = req.query["hub.mode"];
//   const token = req.query["hub.verify_token"];
//   const challenge = req.query["hub.challenge"];

//   if (mode === "subscribe" && token === VERIFY_TOKEN) {
//     console.log("Webhook verified successfully!");
//     return res.status(200).send(challenge);
//   } else {
//     return res.sendStatus(403);
//   }
// });

// // ✅ Receive Messages (POST)
// app.post("/webhook", (req, res) => {
//   console.log("Incoming webhook:", JSON.stringify(req.body, null, 2));
//   res.sendStatus(200);
// });

// const PORT = process.env.PORT || 3000;
// app.listen(PORT, () => {
//   console.log(`Server running on port ${PORT}`);
// });
    