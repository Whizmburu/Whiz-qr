const express = require('express');
const path = require('path');
const qrcode = require('qrcode'); // For generating QR code image data URL
const fs = require('fs').promises; // For directory removal
const crypto = require('crypto');
const मेकWASocket = require('@whiskeysockets/baileys').default;
const { Browsers, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');

const app = express();
const PORT = process.env.PORT || 3000;

const qrSessions = new Map();
const activeUserSessions = new Map();

const TEMP_AUTH_SESSIONS_DIR = 'baileys_temp_qr_sessions';
const PERMANENT_AUTH_SESSIONS_DIR = 'baileys_permanent_auth';
const PERSISTENT_SESSIONS_FILE = path.join(__dirname, 'persistent_user_sessions.json');

let loadedPersistentSessions = {};

fs.mkdir(TEMP_AUTH_SESSIONS_DIR, { recursive: true }).catch(console.error);
fs.mkdir(PERMANENT_AUTH_SESSIONS_DIR, { recursive: true }).catch(console.error);

const STALE_SESSION_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
const MAX_QR_SESSION_AGE_MS = 2 * 60 * 1000;
const QR_VALIDITY_SECONDS = 60;

app.use(express.static(path.join(__dirname, '..', 'public')));

async function cleanupSession(sessionId, authPath, socketInstance, removeFromQrSessionsMap = true) {
    console.log(`Cleaning up session: ${sessionId} at path: ${authPath}`);
    if (socketInstance) {
        try {
            if (socketInstance.ws && socketInstance.ws.readyState === 1) {
                 await socketInstance.logout();
                 console.log(`Socket logged out for session ${sessionId}`);
            } else {
                console.log(`Socket for session ${sessionId} already closed or not connected, skipping logout.`);
            }
        } catch (e) {
            console.error(`Error logging out socket for session ${sessionId}:`, e.message);
        }
    }
    if (authPath) {
        try {
            await fs.rm(authPath, { recursive: true, force: true });
            console.log(`Removed auth directory: ${authPath}`);
        } catch (e) {
            if (e.code !== 'ENOENT') {
                console.error(`Error removing auth directory ${authPath}:`, e.message);
            } else {
                console.log(`Auth directory ${authPath} not found for removal, likely already cleaned.`);
            }
        }
    }
    if (removeFromQrSessionsMap && qrSessions.has(sessionId)) { // Check if it exists before deleting
        qrSessions.delete(sessionId);
        console.log(`Removed session ${sessionId} from qrSessions map.`);
    }
}

async function cleanupOldOrphanedSessions() {
    console.log('Running cleanup for old/orphaned temporary sessions...');
    try {
        const sessionDirs = await fs.readdir(TEMP_AUTH_SESSIONS_DIR);
        for (const dirName of sessionDirs) {
            const sessionIdFromDir = dirName;
            const sessionAuthPath = path.join(TEMP_AUTH_SESSIONS_DIR, dirName);
            let shouldDelete = false;

            const sessionData = qrSessions.get(sessionIdFromDir);
            if (sessionData) {
                if (Date.now() - sessionData.creationTime > MAX_QR_SESSION_AGE_MS * 3 &&
                    sessionData.status !== 'open' &&
                    sessionData.status !== 'transitioned' &&
                    sessionData.status !== 'success_reported') {
                    console.log(`Session ${sessionIdFromDir} is in map but very old and not successfully processed. Marking for cleanup.`);
                    shouldDelete = true;
                }
            } else {
                try {
                    const stats = await fs.stat(sessionAuthPath);
                    if (Date.now() - stats.mtimeMs > STALE_SESSION_CLEANUP_INTERVAL_MS / 2) {
                        console.log(`Session directory ${dirName} is old and not in active map. Marking for cleanup.`);
                        shouldDelete = true;
                    }
                } catch (statError) {
                    if (statError.code === 'ENOENT') {
                        console.log(`Orphaned session directory ${sessionAuthPath} already gone.`);
                    } else {
                        console.error(`Error stating directory ${sessionAuthPath}:`, statError.message);
                        shouldDelete = true;
                    }
                }
            }

            if (shouldDelete) {
                console.log(`Proceeding with cleanup for orphaned/stale temp session: ${sessionIdFromDir}`);
                await cleanupSession(sessionIdFromDir, sessionAuthPath, sessionData ? sessionData.socket : null, true);
            }
        }
    } catch (error) {
        if (error.code === 'ENOENT') {
            console.log(`${TEMP_AUTH_SESSIONS_DIR} does not exist, no temp session cleanup needed yet.`);
        } else {
            console.error('Error during cleanup of old temp sessions:', error);
        }
    }
}

async function loadPersistentSessionsFromFile() {
    try {
        const data = await fs.readFile(PERSISTENT_SESSIONS_FILE, 'utf-8');
        loadedPersistentSessions = JSON.parse(data);
        console.log(`Loaded ${Object.keys(loadedPersistentSessions).length} persistent session(s) from file.`);
    } catch (error) {
        if (error.code === 'ENOENT') {
            console.log('No persistent session file found. Starting fresh.');
            loadedPersistentSessions = {};
        } else {
            console.error('Error loading persistent sessions from file:', error);
            loadedPersistentSessions = {};
        }
    }
}

async function savePersistentUserSession(userJid, sessionDetails) {
    loadedPersistentSessions[userJid] = sessionDetails;
    try {
        await fs.writeFile(PERSISTENT_SESSIONS_FILE, JSON.stringify(loadedPersistentSessions, null, 2), 'utf-8');
        console.log(`Saved persistent session for ${userJid} to file.`);
    } catch (error) {
        console.error(`Error saving persistent session for ${userJid} to file:`, error);
    }
}

async function removePersistentUserSession(userJid) {
    const sanitizedJid = userJid.replace(/[:@.]/g, '_');
    const permanentAuthPath = path.join(PERMANENT_AUTH_SESSIONS_DIR, sanitizedJid);
    delete loadedPersistentSessions[userJid];
    try {
        await fs.writeFile(PERSISTENT_SESSIONS_FILE, JSON.stringify(loadedPersistentSessions, null, 2), 'utf-8');
        console.log(`Removed persistent session metadata for ${userJid} from file.`);
        await fs.rm(permanentAuthPath, { recursive: true, force: true });
        console.log(`Removed permanent auth directory for ${userJid}: ${permanentAuthPath}`);
    } catch (error) {
        console.error(`Error removing persistent session for ${userJid} (metadata or directory):`, error);
    }
}

async function initiateWhatsAppConnection(sessionId, authPath, isTemporaryQrSession = true, existingWhizMdSessionId = null) {
    console.log(`Initiating WhatsApp connection for session: ${sessionId}, path: ${authPath}, temporary: ${isTemporaryQrSession}`);

    const { state, saveCreds } = await useMultiFileAuthState(authPath);
    const socketConfig = {
        auth: state,
        printQRInTerminal: false,
        browser: ['𝐰𝐡𝐢𝐳 𝐦𝐝', 'Chrome', '4.0.0'],
        logger: require('pino')({ level: 'silent' })
    };

    let socket;
    try {
        socket = मेकWASocket(socketConfig);
    } catch (e) {
        console.error(`Failed to create Baileys socket for session ${sessionId}:`, e);
        // If socket creation fails, cleanup its auth path if it was a temporary session
        if (isTemporaryQrSession) {
            await cleanupSession(sessionId, authPath, null, true);
        }
        return null;
    }

    if (isTemporaryQrSession) {
        qrSessions.set(sessionId, {
            qr: null,
            status: 'connecting',
            socket: socket,
            authPath: authPath,
            userJid: null,
            whizMdSessionId: null,
            creationTime: Date.now()
        });
    } else {
        activeUserSessions.set(sessionId, {
            socket: socket,
            authPath: authPath,
            whizMdSessionId: existingWhizMdSessionId,
            creationTime: Date.now()
        });
        console.log(`Persistent session instance for ${sessionId} created and stored in activeUserSessions.`);
    }

    socket.ev.on('creds.update', saveCreds);

    socket.ev.on('connection.update', async (update) => {
        const { connection, qr, lastDisconnect } = update;
        const sessionMap = isTemporaryQrSession ? qrSessions : activeUserSessions;
        const currentSessionData = sessionMap.get(sessionId);

        if (!currentSessionData) {
            console.warn(`No session data for ${sessionId} (type: ${isTemporaryQrSession ? 'QR' : 'User'}) in connection.update. Might be cleaned up.`);
            if (socket && socket.ws && socket.ws.readyState === 1) { // Check if socket exists and is open
                await socket.logout().catch(e => console.error("Error logging out orphaned socket:", e.message));
            }
            return;
        }

        if (qr && isTemporaryQrSession) {
            console.log(`QR code received for temporary session ${sessionId}`);
            currentSessionData.qr = qr;
            currentSessionData.status = 'qr_received';
        }

        if (connection === 'close') {
            const closeReason = lastDisconnect?.error?.message || 'Unknown reason';
            console.log(`Connection closed for session ${sessionId} (type: ${isTemporaryQrSession ? 'QR' : 'User'}). Reason: "${closeReason}"`);
            const statusCode = lastDisconnect?.error?.output?.statusCode;

            if (isTemporaryQrSession) {
                if (currentSessionData.status !== 'transitioned_to_permanent' && currentSessionData.status !== 'success_reported_by_client') {
                    currentSessionData.status = 'closed_early_error'; // New distinct status
                    currentSessionData.error = lastDisconnect?.error || new Error('Unknown close reason'); // Store error
                    console.log(`Temporary QR session ${sessionId} connection closed prematurely or with error. Status: 'closed_early_error'. Reason: ${closeReason}. Cleanup deferred.`);
                } else {
                    // If it was already transitioned or reported, its cleanup is handled by qr-status or the main timeout.
                    // This 'close' event might be for the socket after we've decided to clean it up.
                    console.log(`Temporary QR session ${sessionId} closed (status: ${currentSessionData.status}). Normal if already processed.`);
                }
            } else { // Persistent User Session
                console.log(`Persistent session ${sessionId} closed. Removing from activeUserSessions.`);
                activeUserSessions.delete(sessionId);
                if (statusCode === DisconnectReason.loggedOut || statusCode === 401 || statusCode === 403) {
                    console.log(`Persistent session ${sessionId} unrecoverable auth error. Removing permanent data.`);
                    await removePersistentUserSession(sessionId);
                } else {
                    console.log(`Persistent session ${sessionId} closed (code: ${statusCode}). Will attempt reconnect on next server start if auth files/metadata exist.`);
                }
            }
        } else if (connection === 'open') {
            console.log(`WhatsApp connection opened for session ${sessionId} (type: ${isTemporaryQrSession ? 'QR' : 'User'}). User JID: ${socket.user?.id}`);

            if (isTemporaryQrSession) {
                currentSessionData.status = 'open';
                currentSessionData.userJid = socket.user?.id;

                if (socket.user?.id) {
                    const userJid = socket.user.id;
                    const sanitizedJid = userJid.replace(/[:@.]/g, '_');
                    const permanentAuthPath = path.join(PERMANENT_AUTH_SESSIONS_DIR, sanitizedJid);

                    const whizSecureToken = crypto.randomBytes(16).toString('hex');
                    const whizMdSessionId = `WHIZMD_${whizSecureToken}`;
                    currentSessionData.whizMdSessionId = whizMdSessionId;

                    console.log(`User ${userJid} scanned QR for temp session ${sessionId}. Transitioning to permanent session at ${permanentAuthPath}`);

                    try {
                        await fs.mkdir(permanentAuthPath, { recursive: true });
                        await new Promise(resolve => setTimeout(resolve, 1000));

                        console.log(`Copying auth files from ${authPath} to ${permanentAuthPath}`);
                        await fs.cp(authPath, permanentAuthPath, { recursive: true });
                        console.log(`Auth files copied for ${userJid}.`);

                        await socket.sendMessage(userJid, { text: whizMdSessionId });
                        console.log(`Sent session ID to ${userJid} (via temp session ${sessionId})`);
                        const confirmationMessage = `✅ Pairing Successful with 𝐖𝐇𝐈𝐙-𝐌𝐃
╔════════════════════════════╗
║ 🔗 Repo     : github.com/whizmburu/WHIZ-MD
║ 👑 Owner    : @WHIZ
║ 💡 Tip      : Use .menu to explore features
║ 💻 Status   : Connected & Running
╚════════════════════════════╝
📌 Support Group: https://chat.whatsapp.com/JLmSbTfqf4I2Kh4SNJcWgM
📞 Hotline: +254783683683`;
                        await socket.sendMessage(userJid, { text: confirmationMessage });
                        console.log(`Sent confirmation message to ${userJid} (via temp session ${sessionId})`);

                        await savePersistentUserSession(userJid, {
                            whizMdSessionId: whizMdSessionId,
                            authPath: permanentAuthPath,
                            creationTime: Date.now(),
                            userJid: userJid
                        });

                        currentSessionData.status = 'transitioned_to_permanent'; // New distinct status
                        console.log(`Session for ${userJid} marked as 'transitioned_to_permanent'. Temp session ${sessionId} will be cleaned by qr-status or its expiry timeout.`);

                    } catch (error) {
                        console.error(`Error during transition to persistent session for ${userJid} (temp ${sessionId}):`, error);
                        currentSessionData.status = 'error_transitioning'; // Mark error
                    }
                } else {
                    console.warn(`Connection opened for temp session ${sessionId}, but no user.id. Cannot transition.`);
                    currentSessionData.status = 'error_no_jid'; // Mark error
                }
            } else if (!isTemporaryQrSession && connection === 'open') {
                 const sessionDetails = activeUserSessions.get(sessionId);
                 if (sessionDetails) {
                    console.log(`Persistent session for ${sessionId} (re)connected successfully.`);
                 }
            }
        }
    });
    return socket;
}


app.get('/api/get-qr-code', async (req, res) => {
    const tempSessionId = `qr_${crypto.randomBytes(8).toString('hex')}`;
    const tempAuthPath = path.join(TEMP_AUTH_SESSIONS_DIR, tempSessionId);

    try {
        console.log(`Request for new QR. Generating temporary session ID: ${tempSessionId} at path: ${tempAuthPath}`);
        await fs.mkdir(tempAuthPath, { recursive: true });

        initiateWhatsAppConnection(tempSessionId, tempAuthPath, true);

        let attempts = 0;
        const maxAttempts = 20;
        const pollInterval = 1000;

        const intervalId = setInterval(async () => {
            attempts++;
            const sessionData = qrSessions.get(tempSessionId);

            if (sessionData && sessionData.qr) {
                clearInterval(intervalId);
                try {
                    const qrDataURL = await qrcode.toDataURL(sessionData.qr, { errorCorrectionLevel: 'H', width: 250 });
                    console.log(`QR generated for session ${tempSessionId}, sending to client.`);
                    setTimeout(async () => {
                        const currentSession = qrSessions.get(tempSessionId);
                        // Check if the session still exists and was not successfully processed
                        if (currentSession &&
                            currentSession.status !== 'transitioned_to_permanent' &&
                            currentSession.status !== 'success_reported_by_client') {
                            console.log(`Master timeout for temp QR session ${tempSessionId} (status: ${currentSession.status}). Cleaning up as it was not successfully processed.`);
                            await cleanupSession(tempSessionId, currentSession.authPath, currentSession.socket, true); // true to remove from map
                        } else if (currentSession) {
                            console.log(`Master timeout for temp QR session ${tempSessionId}, but its status is '${currentSession.status}'. Cleanup likely handled or not needed now.`);
                        } else {
                            console.log(`Master timeout for temp QR session ${tempSessionId}, but it's no longer in the map (already cleaned up).`);
                        }
                    }, QR_VALIDITY_SECONDS * 1000 + 10000); // Increased buffer slightly to 10s post-QR validity

                    res.json({ status: 'success', qrDataURL: qrDataURL, tempSessionId: tempSessionId });
                } catch (err) {
                    console.error(`Failed to generate QR code image for session ${tempSessionId}:`, err);
                    await cleanupSession(tempSessionId, tempAuthPath, sessionData.socket);
                    if (!res.headersSent) {
                        res.status(500).json({ status: 'error', message: 'Failed to generate QR image.' });
                    }
                }
            } else if (sessionData && (sessionData.status === 'closed' || sessionData.status === 'error')) {
                clearInterval(intervalId);
                console.error(`Connection closed or errored while waiting for QR for session ${tempSessionId}.`);
                await cleanupSession(tempSessionId, tempAuthPath, sessionData.socket);
                if (!res.headersSent) {
                    res.status(500).json({ status: 'error', message: 'Failed to get QR from WhatsApp (connection closed/error).' });
                }
            } else if (attempts > maxAttempts) {
                clearInterval(intervalId);
                console.error(`Timeout waiting for QR for session ${tempSessionId}.`);
                const existingSessionData = qrSessions.get(tempSessionId);
                await cleanupSession(tempSessionId, tempAuthPath, existingSessionData ? existingSessionData.socket : null);
                if (!res.headersSent) {
                    res.status(500).json({ status: 'error', message: 'Timeout waiting for QR code from WhatsApp.' });
                }
            }
        }, pollInterval);

    } catch (error) {
        console.error(`Critical error in /api/get-qr-code for session ${tempSessionId}:`, error);
        const finalCheckSessionData = qrSessions.get(tempSessionId);
        await cleanupSession(tempSessionId, tempAuthPath, finalCheckSessionData ? finalCheckSessionData.socket : null);
        if (!res.headersSent) {
            res.status(500).json({ status: 'error', message: 'Server error initiating QR session.' });
        }
    }
});

app.get('/api/qr-status/:sessionId', async (req, res) => {
    const { sessionId } = req.params;
    const sessionData = qrSessions.get(sessionId);

    if (!sessionData) {
        return res.status(404).json({ status: 'expired_or_not_found', message: 'Session not found, expired, or already processed.' });
    }

    // Primary success path: QR scanned, data transitioned, ready to inform client
    if (sessionData.status === 'transitioned_to_permanent' && sessionData.userJid && sessionData.whizMdSessionId) {
        console.log(`Client poll: Temp session ${sessionId} successfully transitioned. User: ${sessionData.userJid}. WHIZ-MD ID: ${sessionData.whizMdSessionId}.`);
        res.json({
            status: 'scanned_success',
            message: 'Successfully paired!',
            whizMdSessionId: sessionData.whizMdSessionId,
            userJid: sessionData.userJid
        });

        if (sessionData.status !== 'success_reported') {
            sessionData.status = 'success_reported';
            setTimeout(async () => {
                console.log(`Cleaning up temporary QR session ${sessionId} after successful client poll and data transition.`);
                await cleanupSession(sessionId, sessionData.authPath, sessionData.socket, true);
            }, 2000);
        }
    } else if (sessionData.status === 'qr_received') {
        res.json({ status: 'pending_scan', message: 'QR code generated, waiting for scan.' });
    } else if (sessionData.status === 'connecting') {
        res.json({ status: 'connecting', message: 'Baileys instance is still connecting to get QR.' });
    } else if (sessionData.status === 'closed' || sessionData.status === 'error' || sessionData.status === 'error_transitioning' || sessionData.status === 'error_no_jid') {
        console.log(`Client poll: Temp session ${sessionId} is in a terminal error/closed state (${sessionData.status}).`);
        res.status(410).json({ status: 'expired_or_error', message: 'QR session is no longer valid or an error occurred during pairing.' });
        // Cleanup for temporary sessions in error/closed state is primarily handled by
        // the timeout in get-qr-code or if connection.update itself initiated it.
        // However, if polled here in such a state, we can ensure a cleanup attempt.
        await cleanupSession(sessionId, sessionData.authPath, sessionData.socket, true);
    } else if (sessionData.status === 'success_reported') {
        console.log(`Client poll: Temp session ${sessionId} already reported success and is pending cleanup or cleaned.`);
         res.json({
            status: 'scanned_success',
            message: 'Successfully paired! (Session already processed)',
            whizMdSessionId: sessionData.whizMdSessionId,
            userJid: sessionData.userJid
        });
    }
    else {
        console.warn(`Unknown or unexpected session status for temp session ${sessionId}: ${sessionData.status}`);
        res.status(200).json({ status: sessionData.status || 'unknown_pending', message: 'Session status is currently unknown or pending.' });
    }
});

app.get('/qr', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

app.get('/', (req, res) => {
    res.send('WHIZ-MD QR Generator. Visit <a href="/qr">/qr</a> to get your QR code.');
});

app.listen(PORT, () => {
    console.log(`WHIZ-MD QR Generator server running on http://localhost:${PORT}`);
    loadPersistentSessionsFromFile().then(() => {
        console.log("Persistent session metadata loaded. Server ready.");
        setInterval(cleanupOldOrphanedSessions, STALE_SESSION_CLEANUP_INTERVAL_MS);
    });
});
