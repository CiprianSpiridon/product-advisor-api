# embedjs-mongodb

<p>
<a href="https://www.npmjs.com/package/@llm-tools/embedjs"  target="_blank"><img alt="NPM Version" src="https://img.shields.io/npm/v/%40llm-tools/embedjs?style=for-the-badge"></a>
<a href="https://www.npmjs.com/package/@llm-tools/embedjs"  target="_blank"><img alt="License" src="https://img.shields.io/npm/l/%40llm-tools%2Fembedjs?style=for-the-badge"></a>
</p>

This package extends and offers additional functionality to [embedJs](https://www.npmjs.com/package/@llm-tools/embedjs). Refer to the documentation there for more details.

## Collection Usage

MongoDB collections are used as follows:

- **rag_cache** - Stores loader metadata information only (via `metadataCollection`)
- **customData** - Stores both user memories and cache data, using `loaderId` and `key` as identifiers (via `customDataCollection`)
- **conversations** - Stores conversation history (via `conversationCollection`)

When using `loaderCustomGet()`, always provide both the key and loaderId parameters to properly retrieve cached items.
