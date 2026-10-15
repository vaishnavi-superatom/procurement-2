# Instructions for Shared Module Generation

This folder contains **shared/reusable modules** that are common across all projects (e.g., DynamicBarChart, DynamicDataTable, DynamicForm).

## When to Create a Module Here

- Chart components (bar, line, pie, scatter, etc.)
- Generic data visualization components
- Layout components (DashboardLayout, MultiComponentContainer)
- Form components
- Any component that will be reused across multiple projects

For project-specific components, use `/frontend/src/modules/` instead.

## Steps to Create a New Shared Module

1. **Follow the database schema** at `/analysis/data/schema.json` when generating default queries.

2. **Follow the design system** at `/frontend/src/design-system/tokens.ts` for styling.

3. **Follow the existing module structure** - each module should be in its own folder with an `index.tsx` file.

4. **Add a static Metadata property** to your component for registration:
   ```tsx
   const METADATA = {
     id: "your-component-id",
     name: "YourComponent",
     type: "YourComponentType",  // Used for dynamic lookup by MultiComponentContainer
     description: "Description of what this component does",
     category: "chart|data|layout|form",
     keywords: ["keyword1", "keyword2"],
     props: {
       query: "SQL query or data source",
       title: "Component title",
       config: {
         // Component-specific configuration
       }
     }
   };

   // Attach metadata to component
   (YourComponent as any).Metadata = METADATA;
   ```

5. **Register in superatom.ts** (single source of truth):
   ```tsx
   // In /frontend/src/superatom.ts
   import YourComponent from './shared-modules/YourComponent';

   const COMPONENTS = {
     // ... existing components
     YourComponent,  // Add here - that's it!
   };
   ```

## Important Notes
- The `type` field in Metadata is crucial - `MultiComponentContainer` uses it to match and render the correct component
- Shared modules should be generic and not depend on project-specific data schemas

## Example Component Types

| Type | Component | Description |
|------|-----------|-------------|
| `KPICard` | DynamicKPICard | Key performance indicator card |
| `BarChart` | DynamicBarChart | Bar chart visualization |
| `LineChart` | DynamicLineChart | Line chart visualization |
| `PieChart` | DynamicPieChart | Pie/donut chart |
| `DataTable` | DynamicDataTable | Interactive data table |
| `Form` | DynamicForm | Dynamic form builder |
| `DashboardLayout` | MultiComponentContainer | Multi-component container |