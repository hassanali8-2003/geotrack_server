const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.static(__dirname));

const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: '*',
        methods: ['GET', 'POST'],
    },
});

const trackedDevices = new Map();
const socketToDevice = new Map();

// Geofencing data structure
const geofences = [
    {
        id: 'office',
        name: 'Headquarters',
        lat: 37.7749, // Example: San Francisco
        lng: -122.4194,
        radius: 500, // meters
        color: '#6C63FF'
    }
];

function calculateDistance(lat1, lon1, lat2, lon2) {
    const R = 6371e3; // metres
    const φ1 = lat1 * Math.PI / 180;
    const φ2 = lat2 * Math.PI / 180;
    const Δφ = (lat2 - lat1) * Math.PI / 180;
    const Δλ = (lon2 - lon1) * Math.PI / 180;

    const a = Math.sin(Δφ / 2) * Math.sin(Δφ / 2) +
        Math.cos(φ1) * Math.cos(φ2) *
        Math.sin(Δλ / 2) * Math.sin(Δλ / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

    return R * c; // in metres
}

function checkGeofences(device) {
    if (!device.lat || !device.lng) return [];

    const previousFences = device.insideGeofences || [];
    const currentFences = [];

    geofences.forEach(fence => {
        const distance = calculateDistance(device.lat, device.lng, fence.lat, fence.lng);
        if (distance <= fence.radius) {
            currentFences.push(fence.name);
            if (!previousFences.includes(fence.name)) {
                // Entered fence
                const alert = { type: 'ENTER', device: device.deviceName, fenceName: fence.name, timestamp: new Date().toISOString() };
                io.emit('geofenceAlert', alert);
                console.log(`[GEOFENCE] ${alert.device} ENTERED ${alert.fenceName}`);
            }
        } else if (previousFences.includes(fence.name)) {
            // Exited fence
            const alert = { type: 'EXIT', device: device.deviceName, fenceName: fence.name, timestamp: new Date().toISOString() };
            io.emit('geofenceAlert', alert);
            console.log(`[GEOFENCE] ${alert.device} EXITED ${alert.fenceName}`);
        }
    });

    return currentFences;
}

function buildSnapshot() {
    return {
        devices: Array.from(trackedDevices.values()).sort((a, b) =>
            a.deviceName.localeCompare(b.deviceName)
        ),
        geofences: geofences
    };
}

function emitSnapshot() {
    io.emit('devicesSnapshot', buildSnapshot());
}

function normalizeRegisterPayload(payload, socket) {
    if (typeof payload === 'string') {
        return {
            deviceId: payload,
            deviceName: payload,
            platform: 'unknown',
            socketId: socket.id,
            isOnline: true,
        };
    }

    return {
        deviceId: String(payload?.deviceId || payload?.userId || socket.id),
        deviceName: String(payload?.deviceName || payload?.userId || 'Unknown Device'),
        platform: String(payload?.platform || 'unknown'),
        socketId: socket.id,
        isOnline: true,
    };
}

io.on('connection', (socket) => {
    console.log(`[CONNECTED] New socket connection: ${socket.id}`);

    // Log every single event for debugging
    socket.onAny((eventName, ...args) => {
        console.log(`[INCOMING] Event: ${eventName} | Data:`, JSON.stringify(args[0], null, 2));
    });

    socket.emit('devicesSnapshot', buildSnapshot());

    socket.on('register', (payload) => {
        const device = normalizeRegisterPayload(payload, socket);
        console.log(`Registering device: ${device.deviceName} (${device.deviceId}) on ${device.platform}`);

        const previous = trackedDevices.get(device.deviceId) || {};

        trackedDevices.set(device.deviceId, {
            ...previous,
            ...device,
            timestamp: previous.timestamp || new Date().toISOString(),
        });
        socketToDevice.set(socket.id, device.deviceId);
        emitSnapshot();
    });

    socket.on('updateLocation', (data) => {
        const deviceId = String(
            data?.deviceId || data?.userId || socketToDevice.get(socket.id) || socket.id
        );

        // HIGH VISIBILITY LOG FOR REAL DEVICES
        if (deviceId.includes('android') || deviceId.includes('ios')) {
            console.log('\x1b[45m\x1b[37m[ REAL DEVICE ]\x1b[0m', `Update from ${data.deviceName} (${deviceId})`);
        }

        const previous = trackedDevices.get(deviceId) || {};
        const device = {
            ...previous,
            deviceId,
            deviceName: String(data?.deviceName || previous.deviceName || deviceId),
            platform: String(data?.platform || previous.platform || 'unknown'),
            lat: Number(data?.lat),
            lng: Number(data?.lng),
            accuracy: data?.accuracy == null ? null : Number(data.accuracy),
            speed: data?.speed == null ? null : Number(data.speed),
            timestamp: data?.timestamp || new Date().toISOString(),
            socketId: socket.id,
            isOnline: true,
        };

        // Geofence check
        device.insideGeofences = checkGeofences(device);

        trackedDevices.set(deviceId, device);
        socketToDevice.set(socket.id, deviceId);

        console.log(`Location Update [${device.deviceName}]: Lat ${device.lat}, Lng ${device.lng}, Speed: ${device.speed || 0} km/h`);
        io.emit('locationChanged', device);
        emitSnapshot();
    });

    socket.on('disconnect', () => {
        const deviceId = socketToDevice.get(socket.id);
        console.log('Disconnected:', socket.id, deviceId ? `(Device: ${deviceId})` : '');
        socketToDevice.delete(socket.id);

        if (!deviceId || !trackedDevices.has(deviceId)) {
            return;
        }

        trackedDevices.set(deviceId, {
            ...trackedDevices.get(deviceId),
            isOnline: false,
            socketId: null,
            timestamp: new Date().toISOString(),
        });
        emitSnapshot();
    });
});

app.get('/', (_, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`GeoTrack Server running on port ${PORT}`);
});
