export default {
  // Server configuration
  server: {
    port: process.env.PORT || 3000,
  },
  
  // Provider settings
  provider: {
    // 'openai' or 'ollama'
    type: process.env.PROVIDER_TYPE || 'openai',
    
    // OpenAI configuration
    openai: {
      apiKey: process.env.OPENAI_API_KEY,
      embeddingModel: 'text-embedding-3-small',
      completionModel: 'gpt-4',
      temperature: 0.2,
      maxTokens: 1000,
    },
    
    // Ollama configuration (for future use)
    ollama: {
      baseUrl: process.env.OLLAMA_BASE_URL || 'http://localhost:11434',
      embeddingModel: 'llama3', 
      completionModel: 'llama3',
      temperature: 0.2,
      maxTokens: 1000,
    }
  },
  
  // Vector DB settings
  vectorDb: {
    type: 'lancedb', // Currently only lancedb is supported
    lancedb: {
      dbPath: './vectordb',
      collectionName: 'products',
    }
  },
  
  // Data loading configuration
  dataLoader: {
    csvPath: '../products.csv',
  },
  
  // Search configuration
  search: {
    topK: 5,
  }
} 