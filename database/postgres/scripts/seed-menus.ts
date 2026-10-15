import { createMenu, getAllMenus, deleteMenu } from '../src/project-data-db/menus';

/**
 * Sidebar menu definition.
 *
 * TRIMMED 2026-08-28 to three entries: Add Schedule, Add Port, All Sailings.
 *
 * All Sailings sits at the TOP LEVEL; only the two forms live under Quick
 * Actions. It has to be listed AFTER that group, though — see the comment on
 * `children` for the renderer quirk that makes the order matter.
 *
 * The 22 per-carrier workflow entries (CMA CGM, COSCO, Hapag-Lloyd, Maersk,
 * OOCL, MSC, Evergreen, ONE, ZIM, Unifeeder, Milaha, CU Lines, Cordelia,
 * Blue Water, Interasia, PIL, HMM, KMTC, TS Lines, Yang Ming, Turkon and
 * All Carrier Schedules) plus JNPT Gate Cutoffs were REMOVED FROM THE MENU
 * ONLY. Every one of those components is still registered in
 * frontend/src/superatom.ts and every backend tool is still live in
 * PROJECT_CONFIGS — they remain reachable by asking the agent for them, and
 * All Sailings still calls the carrier tools underneath.
 *
 * To bring one back, re-add an entry here and re-run this script; the previous
 * definitions are in git history for this file.
 */
const MENU_DEF = {
  name: 'Sidebar Left',
  menuJson: {
    name: 'Sidebar Left',
    menuId: 'sidebar-left',
    version: 1,
    children: [
      // ORDER IS LOAD-BEARING: quick-actions MUST stay at index 0.
      //
      // The sidebar renderer (sibling repo runtime-react,
      // src/components/layout/Sidebar.tsx) renders children[0] through one
      // branch guarded by `children[0].id === 'quick-actions'`, then renders
      // `children.slice(1)` through another. The slice is unconditional — it
      // assumes position 0 is that group. Putting anything else first means
      // the guard fails AND the slice eats it, so the entry vanishes from the
      // sidebar with no error anywhere. Confirmed by doing exactly that.
      // {
      //   id: 'quick-actions',
      //   icon: 'mdi:lightning-bolt',
      //   name: 'Quick Actions',
      //   type: 'menu',
      //   sortOrder: 0,
      //   children: [
      //     {
      //       id: 'add-schedule',
      //       icon: 'mdi:table-plus',
      //       name: 'Add Schedule',
      //       type: 'component',
      //       sortOrder: 0,
      //       userMessage: 'Open the Add Schedule form to add a new vessel schedule.',
      //       componentName: 'AddSchedule',
      //     },
      //     {
      //       id: 'add-port',
      //       icon: 'mdi:map-marker-plus',
      //       name: 'Add Port',
      //       type: 'component',
      //       sortOrder: 1,
      //       userMessage: 'Open the Add Port form to add a new port to the ports catalog.',
      //       componentName: 'AddPort',
      //     },
      //   ],
      // },

      // // TOP LEVEL, deliberately NOT inside Quick Actions — but they have to come
      // // after that group for the reason above, so they render as siblings of
      // // Quick Actions rather than above it.
      // {
      //   id: 'all-sailings',
      //   icon: 'mdi:ferry',
      //   name: 'All Sailings',
      //   type: 'component',
      //   sortOrder: 1,
      //   userMessage:
      //     'Show the sailing board — carrier sailings joined to terminal gate open/cutoff times.',
      //   componentName: 'AllSailings',
      // },
      // {
      //   id: 'scraper-logs',
      //   icon: 'mdi:script-text-outline',
      //   name: 'Scraper Logs',
      //   type: 'component',
      //   sortOrder: 2,
      //   userMessage:
      //     'Show the scraper run log — every carrier and port ingest run, its per-lane events and errors.',
      //   componentName: 'ScraperLogs',
      // },
      //
      // All Sailings is a dashboard page in its own right
      // (frontend/src/modules/AllSailings): a board you read, not a form you
      // submit. Sitting beside Add Schedule and Add Port made it read as a
      // third form, since those two really are workflows
      // (frontend/src/workflows/*).
    
    ],
  },
  version: 1,
  isActive: true,
};

async function main() {
  console.log('Seeding menus...\n');

  try {
    // Remove all existing menus to avoid duplicates
    const existing = await getAllMenus();
    for (const menu of existing.data ?? []) {
      await deleteMenu({ id: menu.id });
      console.log(`🗑  Deleted existing menu: ${menu.name} (ID: ${menu.id})`);
    }

    const result = await createMenu(MENU_DEF);
    console.log(`✅ Created: ${result.data.name} (ID: ${result.data.id})`);
  } catch (error) {
    const msg = error instanceof Error ? error.message : error;
    console.error(`❌ Failed: ${msg}`);
  }

  console.log('\nDone!');
  process.exit(0);
}

main();
