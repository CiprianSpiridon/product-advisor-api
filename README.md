# Product Assistant RAG API

A Retrieval-Augmented Generation (RAG) API for e-commerce product queries using the `@llm-tools/embedjs` framework.

## Features

- Natural language querying for product information
- OpenAI GPT-4o for generating answers with related products
- Vector embedding with OpenAI's text-embedding-3-small
- Vector storage with LanceDB
- User and children metadata support for personalized recommendations
- Conversation history tracking
- Network discovery (shows all available IP addresses at startup)
- Bold product names with markdown formatting
- Comprehensive product details in recommendations
- JSON configuration files for easy customization

## Requirements

- Node.js 18+
- OpenAI API key

## Setup

1. Clone the repository
2. Create a `.env` file in the root directory:
   ```
   # Required for OpenAI
   OPENAI_API_KEY=your_api_key_here
   
   # Optional: Custom port (default is 3002)
   PORT=3002
   
   # Optional: RAG configuration 
   # SEARCH_RESULT_COUNT=15
   # TEMPERATURE=0.2
   # EMBEDDING_BATCH_SIZE=256
   ```
3. Install dependencies:
   ```
   cd product-assitant-api
   npm install
   ```
4. Prepare your products.csv file in the `data/` directory
5. Generate embeddings:
   ```
   npm run generate-embeddings
   ```
6. Start the server:
   ```
   npm start
   ```
   Or for development with auto-reload:
   ```
   npm run dev
   ```

## Configuration

The system is configured through JSON files in the `config/` directory:

### `config/app.json`
Contains general application settings:
```json
{
  "server": {
    "port": 3002
  },
  "openai": {
    "embeddingModel": "text-embedding-3-small",
    "completionModel": "gpt-4o"
  },
  "rag": {
    "searchResultCount": 15,
    "temperature": 0.2,
    "embeddingBatchSize": 256
  },
  "vectorDb": {
    "type": "lancedb",
    "path": "vectordb",
    "collectionName": "products"
  },
  "dataLoader": {
    "csvPath": "../data/products.csv"
  }
}
```

### `config/prompts.json`
Contains the prompt templates and instructions for the LLM:
```json
{
  "jsonOutputInstructions": {
    "systemPreamble": "...",
    "answerFieldDetails": "...",
    "relatedProductsFieldDetails": "...",
    "closingInstruction": "..."
  },
  "summarizationInstruction": "..."
}
```

## API Endpoints

### Health Check
```
GET /health
```

Response:
```json
{
  "status": "ok",
  "timestamp": "2023-06-15T12:34:56.789Z"
}
```

### Ask a Question
```
POST /ask
Content-Type: application/json

{
  "query": "What baby gear products do you have for a 2-year-old?",
  "user": {
    "id": "user_12345",
    "name": "Jane Smith",
    "children": [
      {
        "name": "Emma",
        "age": 2,
        "gender": "female",
        "birthday": "2022-03-15"
      }
    ]
  }
}
```

Response:
```json
{
  "answer": "For your 2-year-old daughter Emma, I recommend the **Toddler Travel Stroller**. It's lightweight yet sturdy with adjustable reclining positions, perfect for toddlers her age.",
  "relatedProducts": [
    {
      "sku": "stroller-123",
      "name": "Toddler Travel Stroller",
      "brand_default_store": "KidComfort",
      "description": "Lightweight stroller with adjustable positions",
      "features": "One-hand folding, rain cover included",
      "recom_age": "1-4 years",
      "top_category": "Baby Gear",
      "secondary_category": "Strollers"
    },
    ...more products...
  ]
}
```

### Chat Conversation
```
POST /chat
Content-Type: application/json

{
  "query": "I need something for my daughter's naptime",
  "user": {
    "id": "user_12345",
    "name": "Jane Smith",
    "children": [
      {
        "name": "Emma",
        "age": 2,
        "gender": "female",
        "birthday": "2022-03-15"
      }
    ]
  }
}
```

Response format is the same as `/ask`, but the endpoint maintains conversation history for follow-up questions.

## Testing the API

A test script is included to quickly test the API:

```bash
# With default question
npm run test:api

# With custom question
npm run test:api -- "Do you have any baby strollers?"
```

## Extending the System

- Add authentication for API endpoints
- Implement caching with Redis for faster responses
- Add a web interface for easy querying
- Implement personalized recommendations based on user history
- Add support for multiple languages 