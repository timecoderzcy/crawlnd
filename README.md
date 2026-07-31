# Crawlnd

Node.js TypeScript 爬虫运行时：Spider / Frontier / 请求去重，以及可选的 Admin 控制面。

本仓库是 **npm workspaces monorepo**，只包含可发布的框架包。示例爬虫请在本地应用中自行编写，不纳入本仓库。

## Packages

| Package | npm | Description |
|---------|-----|-------------|
| [`crawlnd`](./packages/core) | [crawlnd](https://www.npmjs.com/package/crawlnd) | Spider, Crawlnd, Frontier, dedupe |
| [`@crawlnd/utils`](./packages/utils) | [@crawlnd/utils](https://www.npmjs.com/package/@crawlnd/utils) | Logger, page seeds, Redis helpers |
| [`@crawlnd/admin`](./packages/admin) | [@crawlnd/admin](https://www.npmjs.com/package/@crawlnd/admin) | HTTP admin API, runs, schedules, workers |

Dependency direction: `your app → @crawlnd/admin → @crawlnd/utils → crawlnd`.

## Install (consumers)

```bash
npm i crawlnd
npm i @crawlnd/utils    # peer: crawlnd
npm i @crawlnd/admin    # peer: crawlnd + @crawlnd/utils
```

## Develop (this repo)

```bash
npm install
npm run build
```

Each package builds to `packages/*/dist` and is published from there (`prepublishOnly` runs build).

## Docs

- [packages/core/README.md](./packages/core/README.md) — runtime & Frontier
- [packages/utils/README.md](./packages/utils/README.md)
- [packages/admin/README.md](./packages/admin/README.md)
- [docs/admin-api.md](./docs/admin-api.md)

## License

ISC
