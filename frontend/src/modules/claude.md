# Instructions for Project-Specific Module Generation

This folder contains **project-specific modules** that are unique to this project (e.g., OrdersList, DatabaseOverview, Home).

## When to Create a Module Here

- Components specific to this project's domain/business logic
- Components that won't be reused across other projects
- For reusable/common components, use `/frontend/src/shared-modules/` instead

## Steps to Create a New Module

1. **Follow the database schema** at `/analysis/data/schema.json` when generating default queries.

2. **Follow the design system** at `/frontend/src/design-system/tokens.ts` for styling.

3. **Follow the existing module structure** - each module should be in its own folder with an `index.tsx` file.

4. **Add a static Metadata property** to your component for registration:
   ```tsx
   const METADATA = {
     id: "your-component-id",
     name: "YourComponent",
     type: "YourComponentType",  // Used for dynamic lookup
     description: "Description of what this component does",
     category: "category-name",
     keywords: ["keyword1", "keyword2"],
     props: {
       // Document expected props
     }
   };

   // Attach metadata to component
   (YourComponent as any).Metadata = METADATA;
   ```

5. **Register in superatom.ts** (single source of truth):
   ```tsx
   // In /frontend/src/superatom.ts
   import YourComponent from './modules/YourComponent';

   const COMPONENTS = {
     // ... existing components
     YourComponent,  // Add here - that's it!
   };
   ```

## Important Notes
- The `type` field in Metadata is used by `MultiComponentContainer` to match and render components