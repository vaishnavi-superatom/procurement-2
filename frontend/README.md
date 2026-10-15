# Frontend Component Bundle

This folder contains the React frontend that provides UI components for the SuperAtom data visualization platform. The components are bundled and loaded by the SuperAtom runtime for dynamic rendering.

## Components

The frontend includes a variety of data visualization and UI components:

### Charts
| Component | Description |
|-----------|-------------|
| `DynamicBarChart` | Bar chart with configurable data and styling |
| `DynamicLineChart` | Line chart for time series and trends |
| `DynamicPieChart` | Pie/donut chart for proportional data |
| `DynamicScatterChart` | Scatter plot for correlation analysis |
| `DynamicGaugeChart` | Gauge chart for KPI visualization |
| `DynamicRadarChart` | Radar/spider chart for multi-dimensional data |
| `DynamicTreemapChart` | Treemap for hierarchical data |
| `DynamicHeatmapChart` | Heatmap for matrix data |
| `DynamicWaterfallChart` | Waterfall chart for financial data |
| `DynamicCandleStickChart` | Candlestick chart for stock data |

### Data Components
| Component | Description |
|-----------|-------------|
| `DynamicDataTable` | Interactive data table with sorting/filtering |
| `DynamicKPICard` | KPI card for key metrics display |
| `DatabaseOverview` | Database schema and statistics overview |

### Layout Components
| Component | Description |
|-----------|-------------|
| `DashboardLayout4Comp` | 4-component dashboard layout |
| `DashboardLayout6Comp` | 6-component dashboard layout |
| `MultiComponentContainer` | Flexible multi-component container |
| `Home` | Home/landing page component |

### Forms & Actions
| Component | Description |
|-----------|-------------|
| `DynamicForm` | Dynamic form builder with validation |
| `OrdersList` | Orders listing component |
| `OrderUpdate` | Order update form |
| `OrderCreation` | Order creation form |

## Quick Start

### 1. Install Dependencies

```bash
cd frontend
pnpm install
```

### 2. Configure Environment

```bash
cp .env.example .env
```

Edit `.env` with your settings:
```env
VITE_USER_ID=user
VITE_SUPERATOM_PROJECT_ID=your-project-id
VITE_SUPERATOM_WS_URL=wss://ws.superatom.ai/websocket
VITE_DEBUG=false
```

### 3. Start Development Server

```bash
pnpm dev
```

### 4. Build for Production

```bash
pnpm build
```

The built bundle will be in `dist/` directory.

## Configuration

### Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `VITE_USER_ID` | No | `user` | User identifier for conversations |
| `VITE_SUPERATOM_PROJECT_ID` | Yes | - | Your SuperAtom project ID |
| `VITE_SUPERATOM_WS_URL` | No | `wss://ws.superatom.ai/websocket` | WebSocket server URL |
| `VITE_DEBUG` | No | `false` | Enable debug logging |

## Available Scripts

```bash
# Start development server with hot reload
pnpm dev

# Build for production
pnpm build

# Preview production build locally
pnpm preview

# Run ESLint
pnpm lint
```

## Folder Structure

```
frontend/
├── README.md                 # This file
├── .env.example              # Environment template
├── .env                      # Your local config (gitignored)
├── package.json              # Dependencies and scripts
├── vite.config.ts            # Vite configuration
├── tsconfig.json             # TypeScript configuration
├── index.html                # HTML entry point
├── public/                   # Static assets
└── src/
    ├── main.tsx              # React entry point
    ├── App.tsx               # Main App component
    ├── superatom.ts          # SDK setup and component registration
    ├── comps-metadata.ts     # Component metadata definitions
    ├── types.ts              # Type definitions
    ├── index.css             # Global styles
    ├── components/           # Shared components
    │   ├── LoadingState.tsx
    │   └── Pagination.tsx
    ├── modules/              # Feature modules (chart components)
    │   ├── DynamicBarChart/
    │   ├── DynamicLineChart/
    │   ├── DynamicPieChart/
    │   ├── DynamicDataTable/
    │   └── ...
    ├── data/                 # Data fetching utilities
    │   ├── query.ts          # Query executor
    │   └── actions.ts        # Actions executor
    ├── design-system/        # Design tokens
    │   └── tokens.ts
    ├── pages/                # Page components
    │   └── Showcase.tsx
    └── utils/                # Utility functions
        └── formatNumber.ts
```

## How It Works

### Component Registration

The frontend registers components with the SuperAtom SDK in `superatom.ts`:

```typescript
import { setup } from '@superatomai/sdk-web';

const COMPONENTS = {
    DynamicBarChart,
    DynamicDataTable,
    // ... other components
    mount: (Component, container, props) => {
        const root = createRoot(container);
        root.render(createElement(Component, props));
        return { unmount: () => root.unmount() };
    }
};

setup(COMPONENTS);
```

### SDK Client

The SDK client is typically injected by the runtime:

```typescript
// Runtime sets the SDK client
const sdkClient = (window as any).SA_WEB_SDK_CLIENT;

// Send component metadata to server
sdkClient.sendComponents(componentsMetadata);
```

### Data Fetching

Components use the QueryExecutor for database queries:

```typescript
const QueryExecutor = (window as any).SA.QueryExecutor;

const data = await QueryExecutor.executeQuery({
    query: 'SELECT * FROM orders LIMIT 10',
    type: 'query',
    timeout: 60000
});
```

### Actions

Components can request available actions:

```typescript
const ActionsExecutor = (window as any).SA.ActionsRequestExecutor;

const { data } = await ActionsExecutor.getActions({
    threadId: 'thread-123',
    uiBlockId: 'block-456'
});
```

## Adding New Components

1. Create component in `src/modules/YourComponent/index.tsx`:

```tsx
interface YourComponentProps {
    title: string;
    data: any[];
}

export default function YourComponent({ title, data }: YourComponentProps) {
    return (
        <div>
            <h2>{title}</h2>
            {/* Component content */}
        </div>
    );
}
```

2. Register in `src/superatom.ts`:

```typescript
import YourComponent from './modules/YourComponent';

const COMPONENTS = {
    // ... existing components
    YourComponent,
};
```

3. Add metadata in `src/comps-metadata.ts`:

```typescript
export const componentsMetadata = [
    // ... existing metadata
    {
        name: 'YourComponent',
        description: 'Description of your component',
        props: {
            title: { type: 'string', required: true },
            data: { type: 'array', required: true }
        }
    }
];
```

## Integration with Backend

The frontend bundle is served by the backend and loaded at runtime:

1. **Build the frontend**: `pnpm build`
2. **Configure backend**: Set `BUNDLE_DIR` to point to `frontend/dist/assets`
3. **Runtime loads bundle**: The SuperAtom runtime loads the component bundle dynamically

## Development Tips

### Local Testing

For local testing without the runtime, you can uncomment the SDK initialization in `superatom.ts`:

```typescript
const sdk = new SuperatomClient({
    userId: config.userId,
    projectId: config.projectId,
    debug: config.debug,
});
```

### Adding Charts

This project uses `echarts-for-react`. To add a new chart type:

1. Check [ECharts documentation](https://echarts.apache.org/en/option.html)
2. Create a new module following the pattern in existing chart components
3. Use the `ReactECharts` component with your chart options

### Design System

Design tokens are defined in `src/design-system/tokens.ts`. Use these for consistent styling:

```typescript
import { colors, spacing, typography } from '../design-system/tokens';
```

## Troubleshooting

### SDK client not initialized

```
Error: SDK client not initialized
```

**Solution:** The SDK client is set by the runtime. For local testing, uncomment the SDK initialization in `superatom.ts`.

### WebSocket connection timeout

```
Error: WebSocket connection timeout
```

**Solution:**
- Check `VITE_SUPERATOM_WS_URL` is correct
- Ensure the backend server is running
- Check network/firewall settings

### Build errors

```
Error: Cannot find module
```

**Solution:**
```bash
rm -rf node_modules
pnpm install
pnpm build
```

### TypeScript errors

Ensure you have the correct TypeScript version:
```bash
pnpm add -D typescript@~5.9.3
```

## Tech Stack

- **React 19** - UI framework
- **TypeScript** - Type safety
- **Vite** - Build tool and dev server
- **Tailwind CSS** - Utility-first CSS
- **ECharts** - Charting library
- **React Hook Form** - Form handling
- **React Router** - Client-side routing

## License

ISC
