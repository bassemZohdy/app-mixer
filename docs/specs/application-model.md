# Application Definition Contract

Three artifacts: (1) versioned **Application Manifest** with metadata, pages/routes, navigation, data sources, actions, permissions and component references; (2) declarative **UI Definitions** rendered through approved A2UI-compatible component adapters; (3) immutable **Published Package** with dependencies, integrity and compatibility metadata, but no environment secrets.

```yaml
application:
  id: customer-app
  schemaVersion: 1
  pages:
    - id: customers
      route: /customers
      components:
        - id: table
          type: DataTable
          dataSource: customers.list
  capabilities:
    customers.list:
      integration: customer-service
      operationId: listCustomers
      permission: customers.read
```

Illustrative framework YAML, **not** the official A2UI wire schema.

Agent patch must carry base revision, be atomic and validated for schema, component registry, capabilities, permissions and compatibility. Failed patch leaves prior draft intact. Preview is isolated. Authorized publishing creates immutable versions; rollback restores an earlier compatible version. Business schema migrations and staged transactions are separate operations.

The prototype implements in-memory and SQLite-backed drafts, basic patches and immutable published versions. The local prototype supports explicit definition schema 1-to-2 draft migration; see [definition migration](../definition-migration.md). Production authorization and complete A2UI serialization remain pending.
