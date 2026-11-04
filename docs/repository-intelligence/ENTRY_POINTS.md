# Entry Points

## Backend

- Workspace manifests: `package.json`, `pnpm-workspace.yaml`, `turbo.json`
- API Gateway: `apps/api-gateway`; core services: `packages/core`; contracts: `packages/contracts`.
- Route manifest: `apps/api-gateway/src/routes/v2/route-manifest.ts`.
- Tests are colocated beside application, route, service, domain, repository, and contract code.

See [ROUTE_INVENTORY](ROUTE_INVENTORY.md) and [API_INVENTORY](API_INVENTORY.md).
