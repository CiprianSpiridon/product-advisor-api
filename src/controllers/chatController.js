import { getProductsBySKUs } from '../../db.mjs';
import ragService from '../services/ragService.js';
import cacheService from '../services/cacheService.js';
import memoryService from '../services/memoryService.js';
import { promptConfig } from '../config/index.js';

export async function handleQuery(req, res, endpointName) {
  console.log(`[${endpointName}] Request received for user: ${req.body.userId || 'default_user'}`);
  const userQuery = req.body.query || req.body.question;
  const user = req.body.user || {};
  const userId = user.id || req.body.userId || req.query.userId || 'default_user';
  const userName = user.name || '';
  const children = user.children || [];

  if (!userQuery) {
    console.log(`[${endpointName}] Query is missing.`);
    return res.status(400).json({ answer: "Query is required.", relatedProducts: [] });
  }

  if (!ragService.ragApplication || !promptConfig) {
    console.error(`[${endpointName}] Critical component not initialized: RAG: ${!!ragService.ragApplication}, PromptConfig: ${!!promptConfig}`);
    return res.status(503).json({
      answer: `RAG system or prompt configuration not initialized yet for ${endpointName}`,
      relatedProducts: []
    });
  }

  try {
    // 1. Cache Handling
    const userMetadataForCacheKey = { name: userName, children };
    const cachedResult = await cacheService.getCachedResult(userId, userQuery, userMetadataForCacheKey);
    
    if (cachedResult) {
      return res.json(cachedResult);
    }

    // 2. Memory Retrieval
    const longTermMemoryContext = await memoryService.getConversationMemory(userId);

    // 3. Build Prompt
    const { systemPreamble, answerFieldDetails, relatedProductsFieldDetails, closingInstruction } = promptConfig.jsonOutputInstructions;
    let promptForRAG = `${systemPreamble}\n\n${answerFieldDetails}\n\n${relatedProductsFieldDetails}\n\n`;

    if (userName || (children && children.length > 0)) {
      promptForRAG += `User profile:\n`;
      if (userName) promptForRAG += `- Name: ${userName}\n`;
      if (children.length > 0) {
        promptForRAG += `- Children:\n`;
        for (const child of children) {
          promptForRAG += `  - Name: ${child.name || ''}, Age: ${child.age || ''}, Gender: ${child.gender || ''}, Birthday: ${child.birthday || ''}\n`;
        }
      }
      promptForRAG += '\n';
    }

    if (longTermMemoryContext && longTermMemoryContext.trim() !== "") { 
      promptForRAG += `Relevant past information for ${userId}:\n${longTermMemoryContext}\n\n`;
    }

    // 4. Conversation History
    const conversationData = await memoryService.getConversationHistory(userId);
    const currentEntries = (conversationData && conversationData.entries) ? conversationData.entries : [];
    const limitedHistoryEntries = currentEntries.slice(-10);
    const shortTermHistoryText = limitedHistoryEntries.map(turn => `${turn.role}: ${turn.content}`).join("\n");
    
    if (shortTermHistoryText) {
      promptForRAG += `Current conversation history:\n${shortTermHistoryText}\n\n`;
    }

    promptForRAG += `User's current query: ${userQuery}\n\n${closingInstruction}`;
    console.log(`[${endpointName}] --- Prompt sent to LLM ---\n${promptForRAG}\n-----------------------------------`);

    // 5. Query RAG
    const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('Request timed out after 15 seconds')), 15000));
    const result = await Promise.race([ragService.query(promptForRAG), timeout]);

    console.log(`[${endpointName}] --- Complete RAG result object ---\n${JSON.stringify(result, null, 2)}\n----------------------------------`);
    let llmOutputString = result.answer || result.content || result.text || result.response || '';
    console.log(`[${endpointName}] --- LLM Raw Output (extracted) ---\n${llmOutputString}\n---------------------------------------------------`);

    // 6. Parse and Process Response
    let botResponseJson;
    try {
      if (typeof llmOutputString !== 'string' || llmOutputString.trim() === "") {
        throw new Error("LLM output is not a non-empty string, cannot parse.");
      }
      
      let cleanedOutput = llmOutputString;
      if (llmOutputString.includes("```")) {
        const codeBlockMatch = llmOutputString.match(/```(?:json)?\s*([\s\S]*?)```/);
        if (codeBlockMatch && codeBlockMatch[1]) cleanedOutput = codeBlockMatch[1].trim();
      }
      
      botResponseJson = JSON.parse(cleanedOutput);

      if (typeof botResponseJson.answer !== 'string' || !Array.isArray(botResponseJson.relatedProducts)) {
        throw new Error("LLM output is not in the expected {answer: string, relatedProducts: array} format.");
      }
      
      botResponseJson.relatedProducts = botResponseJson.relatedProducts.map(sku => typeof sku === 'string' ? sku : String(sku));
      const productDetails = await getProductsBySKUs(botResponseJson.relatedProducts);
      botResponseJson.relatedProducts = productDetails;

    } catch (e) {
      console.error(`[${endpointName}] Failed to parse LLM response or structure was invalid: ${e.message}. LLM Raw: ${llmOutputString}`);
      botResponseJson = { 
        answer: `I had a little trouble formatting my response perfectly. Here's the main information: ${llmOutputString || "Not available"}`,
        relatedProducts: [] 
      };
    }

    // 7. Save Conversation and Cache
    const isValidResponse = botResponseJson && typeof botResponseJson.answer === 'string' && 
      botResponseJson.answer.trim() !== '' && !botResponseJson.answer.includes('I had a little trouble formatting my response');

    if (isValidResponse) {
      // Add conversation entries
      await memoryService.addConversationEntries(userId, userQuery, botResponseJson.answer);
      
      // Cache the result
      await cacheService.setCachedResult(userId, userQuery, userMetadataForCacheKey, botResponseJson);
      
      // Summarize if needed
      await memoryService.summarizeAndStoreMemory(userId, ragService, promptConfig.summarizationInstruction);
    }

    // 8. Return Response
    res.json(botResponseJson);

  } catch (error) {
    console.error(`[${endpointName}] Error processing question:`, error);
    res.status(500).json({ 
      answer: 'Error processing your question', 
      relatedProducts: [],
      details: error.message 
    });
  }
} 