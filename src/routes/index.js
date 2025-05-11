import express from 'express';
import { handleQuery } from '../controllers/chatController.js';

const router = express.Router();

// Health check endpoint
router.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Chat endpoints
router.post('/ask', (req, res) => handleQuery(req, res, '/ask'));
router.post('/chat', (req, res) => handleQuery(req, res, '/chat'));

export default router; 