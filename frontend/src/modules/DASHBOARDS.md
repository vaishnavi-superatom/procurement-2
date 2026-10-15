# Dashboards — how the sidebar decides what to show

The runtime (runtime-react) does **not** hardcode which dashboards a client has.
It discovers them from your **bundle component metadata**. So to add a dashboard,
or to change the Home dashboard / its label, you only edit files in **this bundle**
(`frontend/src/`) — no runtime-react change needed.

There are two things the runtime reads off a component's static `Metadata`:

| Field | Type | What it does |
|-------|------|--------------|
| `dashboard` | `{ label, icon?, order? }` | Makes the component a **top-level dashboard** — it gets its own button in the sidebar and its own `/dash/<key>` route. |
| `homeLabel` | `string` | The label shown on the **Home** button when this component is registered as Home. Defaults to `"Home"`. |

Everything below is about those two fields plus registering the component in
[`superatom.ts`](../superatom.ts).

---

## 1. Anatomy of a dashboard component

A dashboard is just a normal display module (like [`InventoryGlance`](./InventoryGlance/index.tsx))
that carries a `Metadata` with a `dashboard` descriptor.

```tsx
// frontend/src/modules/SalesGlance/index.tsx
import type { ComponentMetadata } from '../../types';

const METADATA: ComponentMetadata = {
  id: 'sales-glance-dashboard',
  name: 'SalesGlance',
  displayName: 'Show sales glance dashboard',
  type: 'SalesGlance',
  category: 'Dashboard',
  description: '...',
  keywords: ['sales', 'dashboard', ...],

  // 👇 this is what makes it a sidebar dashboard
  dashboard: { label: 'Sales Glance', icon: 'mdi:chart-line', order: 2 },

  // (optional) label to use when THIS component is the Home dashboard
  homeLabel: 'Sales Glance',

  props: { title: 'Sales Glance', ... },
};

const SalesGlance: React.FC<any> = (props) => { /* ... */ };
(SalesGlance as any).Metadata = METADATA;
export default SalesGlance;
```

- `label` – sidebar text.
- `icon` – any [Iconify](https://icon-sets.iconify.design/) name (e.g. `mdi:warehouse`). Defaults to `mdi:view-dashboard`.
- `order` – ascending sort among dashboards (lower = higher in the list).

---

## 2. Register it in `superatom.ts`

Add the component to the `COMPONENTS` map in [`superatom.ts`](../superatom.ts).
**The map key is the route segment** — the dashboard opens at `/dash/<key>`.

```ts
import SalesGlance from './modules/SalesGlance';

const COMPONENTS = {
  ...
  InventoryGlance,   // → /dash/InventoryGlance
  SalesGlance,       // → /dash/SalesGlance
  ...
};
```

That's it. The runtime will:
1. show a sidebar button per component that has `Metadata.dashboard` (sorted by `order`), and
2. serve each at `/apps/:projectId/:appId/dash/<key>`.

---

## 3. Having more than one dashboard

Just register more than one component with a `dashboard` descriptor. Example — a
client that wants **Home + Inventory Glance + Sales Glance**:

```ts
const COMPONENTS = {
  ...
  Home,              // the Home module → Home button (/home)
  InventoryGlance,   // dashboard → /dash/InventoryGlance
  SalesGlance,       // dashboard → /dash/SalesGlance
  ...
};
```

Sidebar result: **Home**, **Inventory Glance**, **Sales Glance**.

---

## 4. Choosing the Home dashboard + its label

The Home button always renders whatever is registered under the **`Home`** key
(`SA.COMPONENTS.Home`) at the `/home` route. Two options:

### (a) Keep the normal Home module (default)
```ts
const COMPONENTS = { Home, InventoryGlance, ... };
```
Home button says **"Home"** (no `homeLabel` on the Home module).

### (b) Make a dashboard BE the Home page
Alias the `Home` key to your dashboard component, and give that component a
`homeLabel`:

```ts
// import Home from './modules/Home';   // ← comment out the old Home module
import InventoryGlance from './modules/InventoryGlance';

const COMPONENTS = {
  ...
  Home: InventoryGlance,   // Inventory Glance is now the Home page (/home)
  // InventoryGlance,       // ← don't also register it standalone (see note below)
  ...
};
```
With `InventoryGlance.Metadata.homeLabel = 'Inventory Glance'`, the Home button
reads **"Inventory Glance"**. If `homeLabel` is omitted it falls back to `"Home"`.

> **No duplicates:** the component currently serving as Home is automatically
> excluded from the discovered dashboard list, so it never appears twice — even if
> you accidentally register it under both `Home` and its own key. Still, prefer
> **not** registering the Home component standalone (as shown above) to keep things
> clean and avoid sending duplicate metadata to the agent.

---

## Real example: dev vs prod in this repo

The `InventoryGlance/index.tsx` file is **identical** on both branches — only
`superatom.ts` differs:

- **dev** (`bluelinx-dev`): `Home` (Home module) + `InventoryGlance` standalone
  → sidebar shows **Home + Inventory Glance**.
- **prod** (`bluelinx-prod`): `Home: InventoryGlance` only
  → sidebar shows **Inventory Glance** (as the Home page).

---

## After you change this

The frontend runs from the **built Vite bundle**, so rebuild + redeploy the bundle
for metadata changes to take effect:

```bash
cd frontend && pnpm build
```

(The runtime-react side already understands these fields — you only need to rebuild
runtime-react if you're changing the runtime itself, not when adding a dashboard.)
