# @quereus/shared-ui

> **Stability: Beta** — complete and tested, but the surface is still being shaped; a
> breaking change may land in a minor release. See
> [Stability Tiers](../../docs/stability.md#tiers).

Shared React UI components for Quereus applications. Provides common components used across quoomb-web and other Quereus-based UIs.

## Installation

```bash
npm install @quereus/shared-ui
```

## Usage

```typescript
import { ResultsTable, QueryEditor, SchemaViewer } from '@quereus/shared-ui';
import '@quereus/shared-ui/styles';

function App() {
  const [results, setResults] = useState(null);
  
  return (
    <div>
      <QueryEditor 
        onExecute={async (sql) => {
          const rows = await db.all(sql);
          setResults(rows);
        }}
      />
      {results && <ResultsTable data={results} />}
    </div>
  );
}
```

## Components

### ResultsTable

Displays query results in a tabular format:

```typescript
<ResultsTable 
  data={rows}
  columns={['id', 'name', 'email']}
  sortable={true}
  onRowClick={(row) => console.log('Selected:', row)}
/>
```

### QueryEditor

SQL query input with syntax highlighting:

```typescript
<QueryEditor
  initialValue="SELECT * FROM users"
  onExecute={handleExecute}
  placeholder="Enter SQL..."
/>
```

### SchemaViewer

Display database schema with tables and columns:

```typescript
<SchemaViewer
  tables={[
    { name: 'users', columns: ['id', 'name', 'email'] },
    { name: 'orders', columns: ['id', 'user_id', 'total'] }
  ]}
  onTableSelect={(name) => console.log('Selected table:', name)}
/>
```

## Styles

Import the stylesheet for proper styling:

```typescript
import '@quereus/shared-ui/styles';
```

Or in CSS:

```css
@import '@quereus/shared-ui/dist/styles.css';
```

## Development

```bash
npm run build    # Build components
npm run dev      # Watch mode
```

## Related Packages

- [`quoomb-web`](../quoomb-web/) - Web-based SQL IDE using these components

## License

MIT

