const express = require('express');
const path = require('path');
const qrcode = require('qrcode'); // For generating QR code image data URL
const fs = require('fs').promises; // For directory removal
const मेकWASocket = require('@whiskeysockets/baileys').default;
const { Browsers, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');

const app = express();
const PORT = process.env.PORT || 3000;

let currentQR = null; // In-memory store for the QR code string
let sock = null; // Baileys socket instance
let waConnectionState = 'closed'; // Track connection state
let intentionalLogout = false; // Flag to manage logout for new pairings

// Serve static files from the 'public' directory
app.use(express.static(path.join(__dirname, '..', 'public')));

async function connectToWhatsApp() {
    if (sock) { // If a socket exists, try to close it first
        try {
            await sock.logout();
        } catch (e) {
            console.log("Error logging out previous session, might already be closed:", e);
        }
        sock = null;
    }
    currentQR = null; // Reset QR on new connection attempt
    waConnectionState = 'connecting';

    // Using useMultiFileAuthState as it's the documented method
    // For a QR-only generator, the actual file persistence might not be critical
    // if the server restarts frequently, but Baileys expects this structure.
    // A directory 'baileys_auth_info' will be created if it doesn't exist.
    const { state, saveCreds } = await useMultiFileAuthState('baileys_auth_info');

    intentionalLogout = false; // Reset flag on new connection attempt
    sock = मेकWASocket({
        auth: state,
        printQRInTerminal: false, // We handle QR display on the webpage
        // Attempt to set custom device name. Special characters may be sanitized by WhatsApp.
        browser: ['𝐰𝐡𝐢𝐳 𝐦𝐝', 'Chrome', '4.0.0'],
        logger: require('pino')({ level: 'silent' }) // Can be 'info' for debugging
    });

    sock.ev.on('connection.update', async (update) => {
        const { connection, qr, lastDisconnect } = update;
        if (qr) {
            console.log('QR code received from Baileys.');
            currentQR = qr;
            waConnectionState = 'qr_received';
        }
        if (connection === 'close') {
            waConnectionState = 'closed';
            currentQR = null;
            const statusCode = lastDisconnect?.error?.output?.statusCode;

            if (intentionalLogout) {
                console.log("Connection closed due to intentional logout. Ready for new pairing. Auth folder will be cleared by the scheduled connectToWhatsApp.");
                // The connectToWhatsApp call scheduled in the 'open' event's finally block will handle restarting.
                // We ensure intentionalLogout is reset there.
            } else if (statusCode === DisconnectReason.loggedOut || statusCode === 401 || statusCode === 403) {
                console.log("Connection closed due to unrecoverable auth error (e.g., logged out elsewhere, bad creds). Clearing auth info and starting fresh.");
                // Clear auth info and restart the connection process to get a new QR code.
                try {
                    await fs.rm('baileys_auth_info', { recursive: true, force: true });
                    console.log("Cleared baileys_auth_info directory.");
                } catch (e) {
                    console.error("Error clearing baileys_auth_info directory, might not exist or other issue:", e);
                }
                setTimeout(connectToWhatsApp, 1000); // Restart connection process quickly for a new QR
            } else {
                // For other types of disconnections (network issues, stream errors not handled by logout)
                console.log('Connection closed due to ', lastDisconnect?.error, ', attempting to reconnect automatically...');
                setTimeout(connectToWhatsApp, 5000); // Standard reconnect delay
            }
        } else if (connection === 'open') {
            waConnectionState = 'open';
            currentQR = null; // QR is no longer needed
            console.log('WhatsApp connection opened.');

            // Logic for sending automated messages upon successful pairing
            if (sock && sock.user && sock.user.id) {
                const userJid = sock.user.id;
                console.log(`User ${userJid} connected. Generating session ID and sending messages.`);

                // 1. Generate unique session ID
                const secureToken = require('crypto').randomBytes(16).toString('hex');
                const sessionId = `WHIZMD_${secureToken}`;

                // 2. Send automated WhatsApp messages
                try {
                    // Message 1: Session ID
                    await sock.sendMessage(userJid, { text: sessionId });
                    console.log(`Sent session ID to ${userJid}: ${sessionId}`);

                    // Message 2: Confirmation reply
                    const confirmationMessage = `✅ Pairing Successful with 𝐖𝐇𝐈𝐙-𝐌𝐃
╔════════════════════════════╗
║ 🔗 Repo     : github.com/whizmburu/WHIZ-MD
║ 👑 Owner    : @WHIZ
║ 💡 Tip      : Use .menu to explore features
║ 💻 Status   : Connected & Running
╚════════════════════════════╝
📌 Support Group: https://chat.whatsapp.com/JLmSbTfqf4I2Kh4SNJcWgM
📞 Hotline: +254754783683`;
                    await sock.sendMessage(userJid, { text: confirmationMessage });
                    console.log(`Sent confirmation message to ${userJid}`);

                } catch (error) {
                    console.error(`Failed to send automated messages to ${userJid}:`, error);
                } finally {
                    // After sending messages, log out to allow for a new pairing
                    console.log(`Messages sent to ${userJid}. Logging out this session to allow for new pairing.`);
                    intentionalLogout = true;
                    if (sock) {
                        // Before calling logout, ensure auth info is cleared for a truly fresh start next time
                        try {
                            await fs.rm('baileys_auth_info', { recursive: true, force: true });
                            console.log("Cleared baileys_auth_info directory before intentional logout.");
                        } catch (e) {
                            console.error("Error clearing baileys_auth_info before intentional logout:", e);
                        }
                        await sock.logout(); // This will trigger 'connection.close' with intentionalLogout=true
                    }
                    // Start process for a new QR code after a short delay.
                    // The 'close' handler will see intentionalLogout = true and not auto-reconnect,
                    // allowing this scheduled call to take precedence for a fresh session.
                    setTimeout(connectToWhatsApp, 3000); // Reduced delay
                }
            } else {
                console.error("Connection opened, but sock.user.id is not available. This session might not be fully paired. Logging out to restart.");
                intentionalLogout = true;
                if(sock) {
                     try {
                        await fs.rm('baileys_auth_info', { recursive: true, force: true });
                        console.log("Cleared baileys_auth_info due to incomplete pairing.");
                    } catch (e) {
                        console.error("Error clearing baileys_auth_info for incomplete pairing:", e);
                    }
                    await sock.logout();
                }
                setTimeout(connectToWhatsApp, 1000); // Quick restart
            }
        }
    });

    sock.ev.on('creds.update', saveCreds); // Save creds for in-memory auth

    // We don't need 'messages.upsert' for QR scan confirmation,
    // 'connection.update' with 'open' status and sock.user.id is the primary indicator.
}

// API endpoint for the frontend to fetch the QR code
app.get('/api/get-qr-code', async (req, res) => {
    if (waConnectionState === 'connecting' && !currentQR) {
        return res.status(202).json({ status: 'connecting', message: 'Connecting to WhatsApp, please wait...' });
    }
    if (currentQR) {
        try {
            const qrDataURL = await qrcode.toDataURL(currentQR, { errorCorrectionLevel: 'H', width: 250 });
            // The WHIZ-MD logo embedding will be handled client-side via CSS overlay for simplicity
            // as directly embedding in QR via node-qrcode can be complex for dynamic QRs.
            return res.json({ status: 'success', qrDataURL: qrDataURL });
        } catch (err) {
            console.error('Failed to generate QR code image:', err);
            return res.status(500).json({ status: 'error', message: 'Failed to generate QR code image.' });
        }
    } else if (waConnectionState === 'open') {
        return res.json({ status: 'connected', message: 'Already connected to WhatsApp. No QR code needed.' });
    } else {
        // If no QR and not open, it might be an error or initial connection phase
        return res.status(202).json({ status: 'pending', message: 'Waiting for QR code from WhatsApp. Please refresh shortly.' });
    }
});

// Endpoint to serve the QR code page
app.get('/qr', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

app.get('/', (req, res) => {
    res.send('WHIZ-MD QR Generator. Visit <a href="/qr">/qr</a> to get your QR code.');
});


app.listen(PORT, () => {
    console.log(`WHIZ-MD QR Generator server running on http://localhost:${PORT}`);
    connectToWhatsApp().catch(err => {
        console.error("Initial connection to WhatsApp failed:", err);
        // Potentially retry or provide a status that the service is down
    });
});
