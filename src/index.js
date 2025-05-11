#!/usr/bin/env node

import express from 'express';
import cors from 'cors';
import morgan from 'morgan';

import { config } from './config/index.js';
import ragService from './services/ragService.js';
import cacheService from './services/cacheService.js';
import memoryService from './services/memoryService.js';
import { logServerUrls } from './utils/network.js';
import routes from './routes/index.js';
import { initDatabase, closeDatabase } from '../db.mjs';

// Initialize express app
const app = express();

// Middleware
app.use(cors());
app.use(express.json());
app.use(morgan('dev'));

// Routes
app.use('/', routes);

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('Shutting down gracefully...');
  await ragService.close();
  await closeDatabase();
  process.exit(0);
});

// Initialize and start the server
async function initializeApp() {
  // 1. Initialize Product Database (MongoDB)
  console.log("Initializing Product Database (MongoDB)...");
  const productDbInitialized = await initDatabase();
  if (!productDbInitialized) {
    console.error("FATAL ERROR: Could not initialize Product Database (MongoDB). Exiting.");
    process.exit(1);
  }

  // 2. Initialize RAG Service
  try {
    await ragService.initialize();
    
    // Share the mongoStore with other services
    cacheService.initialize(ragService.mongoStore);
    memoryService.initialize(ragService.mongoStore);
    
    console.log("RAG Application, caching, and memory services initialized successfully.");
  } catch (error) {
    console.error("FATAL ERROR: Could not initialize RAG Application. Exiting.", error);
    console.error('Ensure Qdrant & MongoDB are running and accessible, and embeddings are generated.');
    process.exit(1);
  }

  // 3. Start the server
  const PORT = config.server.port;
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on port ${PORT}. RAG App, Prompts, Product DB, and MongoStore Initialized.`);
    logServerUrls(PORT);
  });
}

// Start the application
initializeApp().catch(initializationError => {
  console.error("Application failed to initialize:", initializationError);
  process.exit(1);
}); 