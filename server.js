const express = require('express');
const path = require('path');
const http = require('http');
const cors = require('cors');

// SERVER CONFIG
const PORT = process.env.PORT || 5000;
const app = express();

// Middleware
app.use(cors({ credentials: true, origin: '*' }));
app.use(express.static(path.join(__dirname, 'public')));

// Create HTTP server
const server = http.createServer(app);

// Start the server
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

// Handle server errors
server.on('error', (error) => {
  console.error(`Error starting server: ${error.message}`);
});
