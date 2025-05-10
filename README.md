# Product Assistant RAG API

A Retrieval-Augmented Generation (RAG) API for e-commerce product queries using the `@llm-tools/embedjs` framework.

## Features

- Natural language querying for product information
- OpenAI GPT-4 for answering queries
- Vector embedding with OpenAI's text-embedding-3-small
- Vector storage with LanceDB
- Support for switching between OpenAI and Ollama
- Express.js API with health check and query endpoint
- Configurable through a single config file

## Requirements

- Node.js 18+
- OpenAI API key (if using OpenAI)
- Ollama running locally (if using Ollama)

## Setup

1. Clone the repository
2. Create a `.env` file in the root directory:
   ```
   # Required for OpenAI
   OPENAI_API_KEY=your_api_key_here
   
   # Optional: Switch to ollama (default is 'openai')
   # PROVIDER_TYPE=ollama
   
   # Optional: Custom Ollama URL (default is http://localhost:11434)
   # OLLAMA_BASE_URL=http://localhost:11434
   
   # Optional: Custom port (default is 3000)
   # PORT=3000
   ```
3. Install dependencies:
   ```
   cd product-assitant-api
   npm install
   ```
4. Prepare your products.csv file (sample already included)
5. Start the server:
   ```
   npm start
   ```
   Or for development with auto-reload:
   ```
   npm run dev
   ```

## Configuration

The system is configured through `config.js`. The main configuration options are:

- `provider.type`: 'openai' or 'ollama'
- `provider.openai`: OpenAI-specific settings
- `provider.ollama`: Ollama-specific settings
- `vectorDb`: Vector database settings
- `search.topK`: Number of similar products to retrieve (default: 5)

## API Usage

### Health Check
```
GET /health
```

Response:
```json
{
  "status": "ok",
  "provider": "openai",
  "timestamp": "2023-06-15T12:34:56.789Z"
}
```

### Ask a Question
```
POST /ask
Content-Type: application/json

{
  "question": "What baby gear products do you have?"
}
```

Response:
```json
{
  "answer": "Based on the provided information, we have a product called 'Stroller A' in the Baby Gear category. It's a lightweight stroller with twin seats that features adjustable recline and a sun canopy. It's priced at 999.",
  "relatedProducts": [
    {
      "id": "product-123abc",
      "title": "Stroller A",
      "price": "999",
      "category": "Baby Gear",
      "score": 0.92
    }
  ]
}
```

## Testing the API

A test script is included to quickly test the API:

```bash
# With default question
npm run test:api

# With custom question
npm run test:api -- "Do you have any baby strollers?"
```

Or directly:

```bash
node test.mjs "What baby products do you have?"
```

## Switching to Ollama

To use Ollama instead of OpenAI:

1. Make sure Ollama is installed and running locally
2. Set `PROVIDER_TYPE=ollama` in your `.env` file
3. Restart the server

## Extending the System

- Add more vector databases by implementing other providers from `embedjs`
- Implement caching with Redis for faster responses
- Add authentication for the API endpoints 