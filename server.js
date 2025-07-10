const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, Browsers } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode');
const path = require('path');
const fs = require('fs').promises; // Use promises for fs operations

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 3000;

// Serve static files from the current directory
app.use(express.static(path.join(__dirname))); // For script.js, styles.css

// Setup EJS view engine
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));


// Store active Baileys sockets and their associated WebSockets
// For simplicity, this example manages one main Baileys instance.
// A real multi-user app would need more sophisticated session management.
let sock = null;
let clientWs = null; // The WebSocket connection to the frontend client
let pairingData = {
    qr: null,
    pairingCode: null,
    status: 'disconnected', // disconnected, connecting, qr, code_requested, connected
    userPhoneNumber: null, // Phone number to send confirmation to
    sessionId: null
};

const sessionsDir = path.join(__dirname, 'auth_info_baileys');

// Ensure the sessions directory exists
async function ensureSessionsDir() {
    try {
        await fs.mkdir(sessionsDir, { recursive: true });
        console.log(`Directory ${sessionsDir} ensured.`);
    } catch (error) {
        console.error('Error creating sessions directory:', error);
    }
}
ensureSessionsDir();


async function startBaileys(type, phoneNumberForPairingCode = null) {
    if (sock) {
        console.log('Baileys socket already exists. Closing existing one before starting new.');
        try {
            await sock.logout(); // or sock.end(new Error('Starting new session'))
        } catch (e) {
            console.error('Error closing existing Baileys socket:', e);
        }
        sock = null;
    }

    pairingData = { // Reset pairing data
        qr: null,
        pairingCode: null,
        status: 'connecting',
        userPhoneNumber: type === 'code' ? phoneNumberForPairingCode : null,
        sessionId: null
    };

    if (clientWs && clientWs.readyState === WebSocket.OPEN) {
        clientWs.send(JSON.stringify({ event: 'statusUpdate', message: 'Initializing WhatsApp connection...' }));
    }

    const sessionDir = path.join(sessionsDir, `session-${type}`);
    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);

    sock = makeWASocket({
        auth: state,
        printQRInTerminal: false, // We'll send it via WebSocket
        browser: Browsers.macOS('Desktop'),
        logger: require('pino')({ level: 'silent' }) //প্রেমিকা একটি মাল্টিডিভাইস, ধন্যবাদ
    });

    // For Pairing Code
    if (type === 'code' && phoneNumberForPairingCode && !sock.authState.creds.registered) {
        console.log(`Requesting pairing code for ${phoneNumberForPairingCode}`);
        if (clientWs && clientWs.readyState === WebSocket.OPEN) {
            clientWs.send(JSON.stringify({ event: 'statusUpdate', message: 'Requesting pairing code...' }));
        }
        try {
            // Ensure the phone number is stripped of any non-digits and '+'
            const formattedPhoneNumber = phoneNumberForPairingCode.replace(/\D/g, '');
            if (!formattedPhoneNumber) {
                throw new Error("Invalid phone number for pairing code.");
            }
            const code = await sock.requestPairingCode(formattedPhoneNumber);
            pairingData.pairingCode = code;
            pairingData.status = 'code_requested';
            console.log(`Pairing code: ${code}`);
            if (clientWs && clientWs.readyState === WebSocket.OPEN) {
                clientWs.send(JSON.stringify({ event: 'pairingCodeGenerated', pairingCode: code }));
            }
        } catch (error) {
            console.error('Error requesting pairing code:', error);
            pairingData.status = 'error';
            if (clientWs && clientWs.readyState === WebSocket.OPEN) {
                clientWs.send(JSON.stringify({ event: 'errorMessage', message: `Error requesting pairing code: ${error.message}` }));
            }
            return; // Stop further processing for this connection
        }
    }


    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        console.log('Connection update:', update);

        if (qr) {
            pairingData.qr = await qrcode.toDataURL(qr);
            pairingData.status = 'qr';
            if (clientWs && clientWs.readyState === WebSocket.OPEN) {
                clientWs.send(JSON.stringify({ event: 'qrUpdate', qr: pairingData.qr }));
            }
        }

        if (connection === 'close') {
            pairingData.status = 'disconnected';
            const shouldReconnect = (lastDisconnect.error)?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log('Connection closed due to ', lastDisconnect.error, ', reconnecting ', shouldReconnect);

            if (clientWs && clientWs.readyState === WebSocket.OPEN) {
                 clientWs.send(JSON.stringify({ event: 'statusUpdate', message: `Connection Closed: ${lastDisconnect.error}. ${shouldReconnect ? 'Attempting to reconnect...' : 'Logged out.'}` }));
            }
            if (shouldReconnect) {
                // startBaileys(type, pairingData.userPhoneNumber); // Reconnect logic might be needed here
            } else {
                console.log("Logged out, not reconnecting. Cleaning up session.");
                 try {
                    // Optional: Clean up session files on logout
                    // await fs.rm(path.join(sessionsDir, `session-${type}`), { recursive: true, force: true });
                    // console.log(`Session data for session-${type} cleaned up.`);
                } catch (e) {
                    console.error("Error cleaning up session data:", e);
                }
                sock = null; // Clear the socket
                 if (clientWs && clientWs.readyState === WebSocket.OPEN) {
                    clientWs.send(JSON.stringify({ event: 'statusUpdate', message: 'Logged out. Please restart pairing if needed.'}));
                }
            }
        } else if (connection === 'open') {
            pairingData.status = 'connected';
            const pairedNumberJid = sock.authState.creds.me.id; // Full JID, e.g., 1234567890@s.whatsapp.net
            console.log(`Connected! Paired Number JID: ${pairedNumberJid}`);

            // 1. Read creds.json content
            let credsContent = "";
            try {
                const currentSessionDir = path.join(sessionsDir, `session-${pairingData.type || type}`); // Ensure 'type' is correct
                const credsPath = path.join(currentSessionDir, 'creds.json');
                credsContent = await fs.readFile(credsPath, { encoding: 'utf8' });
                pairingData.sessionId = `WHIZMD_${credsContent}`; // This will be very long
                console.log(`Successfully read creds.json for session ID.`);
            } catch (readError) {
                console.error('Error reading creds.json:', readError);
                pairingData.sessionId = "WHIZMD_ErrorReadingSessionFile";
                // Notify client about the error in getting session ID for the message
                if (clientWs && clientWs.readyState === WebSocket.OPEN) {
                     clientWs.send(JSON.stringify({ event: 'errorMessage', message: 'Paired, but failed to read session data for confirmation message.' }));
                }
            }

            // 2. Send WHIZMD_{session_id} message
            const firstMessageContent = `WHIZMD_${credsContent}`; // Send the raw creds content
            let firstMessageSentInfo;
            try {
                console.log(`Attempting to send session ID message to ${pairedNumberJid}`);
                firstMessageSentInfo = await sock.sendMessage(pairedNumberJid, { text: firstMessageContent });
                console.log(`Session ID message sent to ${pairedNumberJid}. Message ID: ${firstMessageSentInfo?.key?.id}`);
            } catch (err) {
                console.error(`Failed to send session ID message to ${pairedNumberJid}:`, err);
                 if (clientWs && clientWs.readyState === WebSocket.OPEN) {
                    clientWs.send(JSON.stringify({
                        event: 'pairingSuccess',
                        message: `Successfully paired! BUT failed to send session ID message. You might need to fetch session data manually if required.`,
                        sessionId: "WHIZMD_FailedToSend", // Indicate failure
                        errorOnSend: true
                    }));
                }
                // Optionally, don't proceed to send the second message if the first one fails
                return;
            }

            // 3. Send the detailed success message as a reply
            if (firstMessageSentInfo) {
                const successMessageBody = `❀━━━━ HELLO DEAR ━━━━━ ╮ ❀\n*👏WHIZ-MD CONNECTED*👏\n\n❀ Congrats🎊First Step of Making a bot ❀ is successfuly completed🎊\n❀ Owner : +254754783683\n❀ Group : https://chat.whatsapp.com/JLmSbTfqf4I2Kh4SNJcWgM\n❀ Version : 1.0.0\n❀ Repo : github.com/whizmburu/whiz-md\n\nDont know to deploy? Visit : https://github.com/Whizmburu/whiz-md/tree/main#-deployment\n❀━━━━━━━━━━━━━━━━━╯`;

                try {
                    console.log(`Attempting to send success message as reply to ${pairedNumberJid}, replying to message ID ${firstMessageSentInfo.key.id}`);
                    await sock.sendMessage(pairedNumberJid,
                        { text: successMessageBody },
                        { quoted: firstMessageSentInfo }
                    );
                    console.log(`Success message (reply) sent to ${pairedNumberJid}`);
                    if (clientWs && clientWs.readyState === WebSocket.OPEN) {
                        clientWs.send(JSON.stringify({
                            event: 'pairingSuccess',
                            message: `Successfully paired! Confirmation messages sent to your WhatsApp.`,
                            // We don't send the full creds.json to the client browser for security.
                            // The user gets it in their WhatsApp.
                            sessionId: `WHIZMD_SentToWhatsApp`,
                            phoneNumber: pairedNumberJid.split('@')[0]
                        }));
                    }
                } catch (replyErr) {
                    console.error(`Failed to send success message (reply) to ${pairedNumberJid}:`, replyErr);
                    if (clientWs && clientWs.readyState === WebSocket.OPEN) {
                        clientWs.send(JSON.stringify({
                            event: 'pairingSuccess',
                            message: `Successfully paired! Session ID sent, but failed to send detailed success message reply.`,
                            sessionId: "WHIZMD_SentToWhatsApp_ReplyFailed",
                            errorOnSend: true
                        }));
                    }
                }
            } else {
                 console.log("Skipping reply message because first message (session ID) was not sent successfully.");
            }

            // Store the type of pairing for session dir identification if needed elsewhere
            pairingData.type = type;
        }
    });

    sock.ev.on('creds.update', saveCreds);
}

// HTTP endpoint to initiate pairing (primarily for initial request from HTML pages)
// Actual QR/code data will be sent over WebSocket
app.get('/start-pairing', async (req, res) => {
    const type = req.query.type; // 'qr' or 'code'
    const phoneNumber = req.query.phoneNumber; // For pairing code

    pairingData.type = type; // Store the type for later use, e.g. in creds.json path

    if (type === 'code' && (!phoneNumber || !/^\d+$/.test(phoneNumber))) {
        return res.status(400).json({ error: 'Valid phone number is required for pairing code.' });
    }

    // Client should connect via WebSocket after this
    // If already connecting/connected, this endpoint might just acknowledge
    if (pairingData.status === 'connecting' || pairingData.status === 'qr' || pairingData.status === 'code_requested' || pairingData.status === 'connected') {
         console.log(`Pairing process already active with status: ${pairingData.status}`);
         // Send current state if client is just re-requesting
         if (type === 'qr' && pairingData.qr) {
            return res.json({ qr: pairingData.qr, message: "Pairing in progress, QR already generated." });
         }
         if (type === 'code' && pairingData.pairingCode) {
             return res.json({ pairingCode: pairingData.pairingCode, message: "Pairing in progress, code already generated." });
         }
         // If no specific data yet but process active
         return res.json({ message: `Pairing process active (${pairingData.status}). Connect via WebSocket for updates.` });
    }

    console.log(`Received request to start pairing: type=${type}, phone=${phoneNumber}`);

    // The actual Baileys start will be triggered by WebSocket connection usually,
    // but for direct HTTP GET to kick things off:
    // We will rely on the client connecting via WebSocket to get the QR/code.
    // This HTTP endpoint mainly signals the intent.

    // For QR, we can send the QR if it's already generated and a WS isn't active yet
    // For Code, we need the WS to send the code back after generation.

    if (type === 'qr') {
        // If a WS connection is established, it will call startBaileys.
        // If not, this HTTP response can return the QR if available or prompt WS connection.
        if (pairingData.qr) {
             res.json({ qr: pairingData.qr });
        } else {
            // Prompt client to connect via WebSocket to get the QR
            // The actual startBaileys for QR will be triggered by the WS connection message
            res.json({ message: "Connect via WebSocket to receive QR code." });
        }
    } else if (type === 'code') {
        // For pairing code, the phone number is essential.
        // The actual startBaileys for code will be triggered by the WS connection message
        // that includes the phone number.
        res.json({ message: "Connect via WebSocket and send phone number to generate pairing code." });
    } else {
        res.status(400).json({ error: 'Invalid pairing type specified.' });
    }
});

wss.on('connection', (ws) => {
    console.log('Frontend client connected via WebSocket.');
    clientWs = ws; // Store the active client WebSocket

    // Send current status if a pairing process was already underway
    if (pairingData.status === 'qr' && pairingData.qr) {
        ws.send(JSON.stringify({ event: 'qrUpdate', qr: pairingData.qr }));
    } else if (pairingData.status === 'code_requested' && pairingData.pairingCode) {
        ws.send(JSON.stringify({ event: 'pairingCodeGenerated', pairingCode: pairingData.pairingCode }));
    } else if (pairingData.status === 'connecting') {
        ws.send(JSON.stringify({ event: 'statusUpdate', message: 'Server is initializing WhatsApp connection...' }));
    } else if (pairingData.status === 'connected') {
         ws.send(JSON.stringify({
            event: 'pairingSuccess',
            message: `Already paired. Session ID: ${pairingData.sessionId ? 'SentToWhatsApp' : 'ErrorFetching'}`, // Don't send full creds to browser
            sessionId: pairingData.sessionId ? 'WHIZMD_SentToWhatsApp' : "WHIZMD_ErrorFetching",
            phoneNumber: pairingData.userPhoneNumber
        }));
    }


    ws.on('message', async (message) => {
        console.log('Received message from client:', message.toString());
        try {
            const data = JSON.parse(message.toString());
            if (data.type === 'requestQr') {
                pairingData.userPhoneNumber = null; // No longer taking phone number from QR page form
                pairingData.type = 'qr'; // Set type for session path
                console.log(`QR request from client.`);
                if (sock && pairingData.status === 'qr' && pairingData.qr) {
                    ws.send(JSON.stringify({ event: 'qrUpdate', qr: pairingData.qr }));
                } else if (!sock || (sock && pairingData.status !== 'connecting' && pairingData.status !== 'qr')) {
                    await startBaileys('qr');
                } else {
                     ws.send(JSON.stringify({ event: 'statusUpdate', message: 'QR generation already in progress or socket busy.' }));
                }
            } else if (data.type === 'requestCode') {
                const userPhoneNumberForCode = data.phoneNumber;
                 pairingData.type = 'code'; // Set type for session path
                if (!userPhoneNumberForCode || !/^\d{10,15}$/.test(userPhoneNumberForCode)) { // Basic validation
                    ws.send(JSON.stringify({ event: 'errorMessage', message: 'Valid phone number (10-15 digits) is required to generate pairing code.' }));
                    return;
                }
                pairingData.userPhoneNumber = userPhoneNumberForCode; // Store for Baileys' requestPairingCode
                console.log(`Pairing code request from client for ${userPhoneNumberForCode}.`);
                 if (sock && pairingData.status === 'code_requested' && pairingData.pairingCode) {
                    ws.send(JSON.stringify({ event: 'pairingCodeGenerated', pairingCode: pairingData.pairingCode }));
                } else if (!sock || (sock && pairingData.status !== 'connecting' && pairingData.status !== 'code_requested')) {
                    await startBaileys('code', userPhoneNumberForCode);
                } else {
                    ws.send(JSON.stringify({ event: 'statusUpdate', message: 'Pairing code generation already in progress or socket busy.' }));
                }
            }
            // Consider closing the Baileys socket if only one-time pairing is needed per server start
            // await sock.logout();
            // sock = null;
        }
    });

    sock.ev.on('creds.update', saveCreds);
}

// HTTP endpoint to initiate pairing (primarily for initial request from HTML pages)
// Actual QR/code data will be sent over WebSocket
app.get('/start-pairing', async (req, res) => {
    const type = req.query.type; // 'qr' or 'code'
    const phoneNumber = req.query.phoneNumber; // For pairing code

    if (type === 'code' && (!phoneNumber || !/^\d+$/.test(phoneNumber))) {
        return res.status(400).json({ error: 'Valid phone number is required for pairing code.' });
    }

    // Client should connect via WebSocket after this
    // If already connecting/connected, this endpoint might just acknowledge
    if (pairingData.status === 'connecting' || pairingData.status === 'qr' || pairingData.status === 'code_requested' || pairingData.status === 'connected') {
         console.log(`Pairing process already active with status: ${pairingData.status}`);
         // Send current state if client is just re-requesting
         if (type === 'qr' && pairingData.qr) {
            return res.json({ qr: pairingData.qr, message: "Pairing in progress, QR already generated." });
         }
         if (type === 'code' && pairingData.pairingCode) {
             return res.json({ pairingCode: pairingData.pairingCode, message: "Pairing in progress, code already generated." });
         }
         // If no specific data yet but process active
         return res.json({ message: `Pairing process active (${pairingData.status}). Connect via WebSocket for updates.` });
    }

    console.log(`Received request to start pairing: type=${type}, phone=${phoneNumber}`);

    // The actual Baileys start will be triggered by WebSocket connection usually,
    // but for direct HTTP GET to kick things off:
    // We will rely on the client connecting via WebSocket to get the QR/code.
    // This HTTP endpoint mainly signals the intent.

    // For QR, we can send the QR if it's already generated and a WS isn't active yet
    // For Code, we need the WS to send the code back after generation.

    if (type === 'qr') {
        // If a WS connection is established, it will call startBaileys.
        // If not, this HTTP response can return the QR if available or prompt WS connection.
        if (pairingData.qr) {
             res.json({ qr: pairingData.qr });
        } else {
            // Prompt client to connect via WebSocket to get the QR
            // The actual startBaileys for QR will be triggered by the WS connection message
            res.json({ message: "Connect via WebSocket to receive QR code." });
        }
    } else if (type === 'code') {
        // For pairing code, the phone number is essential.
        // The actual startBaileys for code will be triggered by the WS connection message
        // that includes the phone number.
        res.json({ message: "Connect via WebSocket and send phone number to generate pairing code." });
    } else {
        res.status(400).json({ error: 'Invalid pairing type specified.' });
    }
});

wss.on('connection', (ws) => {
    console.log('Frontend client connected via WebSocket.');
    clientWs = ws; // Store the active client WebSocket

    // Send current status if a pairing process was already underway
    if (pairingData.status === 'qr' && pairingData.qr) {
        ws.send(JSON.stringify({ event: 'qrUpdate', qr: pairingData.qr }));
    } else if (pairingData.status === 'code_requested' && pairingData.pairingCode) {
        ws.send(JSON.stringify({ event: 'pairingCodeGenerated', pairingCode: pairingData.pairingCode }));
    } else if (pairingData.status === 'connecting') {
        ws.send(JSON.stringify({ event: 'statusUpdate', message: 'Server is initializing WhatsApp connection...' }));
    } else if (pairingData.status === 'connected') {
         ws.send(JSON.stringify({
            event: 'pairingSuccess',
            message: `Already paired. Session ID: ${pairingData.sessionId}`,
            sessionId: pairingData.sessionId,
            phoneNumber: pairingData.userPhoneNumber
        }));
    }


    ws.on('message', async (message) => {
        console.log('Received message from client:', message.toString());
        try {
            const data = JSON.parse(message.toString());
            if (data.type === 'requestQr') {
                pairingData.userPhoneNumber = data.phoneNumber; // Store phone number for confirmation later
                console.log(`QR request from client. User phone for confirmation: ${pairingData.userPhoneNumber}`);
                if (sock && pairingData.status === 'qr' && pairingData.qr) {
                    ws.send(JSON.stringify({ event: 'qrUpdate', qr: pairingData.qr }));
                } else if (!sock || (sock && pairingData.status !== 'connecting' && pairingData.status !== 'qr')) {
                    await startBaileys('qr');
                } else {
                     ws.send(JSON.stringify({ event: 'statusUpdate', message: 'QR generation already in progress or socket busy.' }));
                }
            } else if (data.type === 'requestCode') {
                const userPhoneNumberForCode = data.phoneNumber;
                if (!userPhoneNumberForCode || !/^\d+$/.test(userPhoneNumberForCode)) {
                    ws.send(JSON.stringify({ event: 'errorMessage', message: 'Valid phone number is required to generate pairing code.' }));
                    return;
                }
                pairingData.userPhoneNumber = userPhoneNumberForCode; // Store for confirmation
                console.log(`Pairing code request from client for ${userPhoneNumberForCode}.`);
                 if (sock && pairingData.status === 'code_requested' && pairingData.pairingCode) {
                    ws.send(JSON.stringify({ event: 'pairingCodeGenerated', pairingCode: pairingData.pairingCode }));
                } else if (!sock || (sock && pairingData.status !== 'connecting' && pairingData.status !== 'code_requested')) {
                    await startBaileys('code', userPhoneNumberForCode);
                } else {
                    ws.send(JSON.stringify({ event: 'statusUpdate', message: 'Pairing code generation already in progress or socket busy.' }));
                }
            }
        } catch (e) {
            console.error('Error processing message from client:', e);
            ws.send(JSON.stringify({ event: 'errorMessage', message: 'Invalid message format.' }));
        }
    });

    ws.on('close', () => {
        console.log('Frontend client disconnected WebSocket.');
        if (ws === clientWs) {
            clientWs = null; // Clear the stored client WebSocket
            // Optionally, you might want to stop Baileys if the client disconnects
            // and no pairing is active or if you want to enforce a single client.
            // if (sock && pairingData.status !== 'connected') {
            //     console.log("Client disconnected, stopping Baileys pairing attempt.");
            //     sock.logout(); // or sock.end(...)
            //     sock = null;
            //     pairingData = { status: 'disconnected' };
            // }
        }
    });

    ws.on('error', (error) => {
        console.error('WebSocket error with client:', error);
         if (ws === clientWs) {
            clientWs = null;
        }
    });
});

// Serve EJS templates
app.get('/', (req, res) => {
    res.render('index');
});
app.get('/qr', (req, res) => {
    res.render('qr');
});
app.get('/pairing-code', (req, res) => {
    res.render('pairing_code');
});


server.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
    console.log(`WebSocket server established on ws://localhost:${PORT}`);
});

process.on('SIGINT', async () => {
    console.log("Shutting down server...");
    if (sock) {
        try {
            // await sock.logout(); // Proper logout if connected
            console.log("Baileys socket closed.");
        } catch (e) {
            console.error("Error during Baileys socket logout:", e);
        }
    }
    server.close(() => {
        console.log('HTTP server closed.');
        process.exit(0);
    });
});
