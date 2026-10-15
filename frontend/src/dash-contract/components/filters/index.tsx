/**
 * The filter set.
 *
 * Shaped after Metabase's parameter widgets, which solved the thing that makes
 * filters look wrong: **a filter is chrome, not content.** Theirs render as a
 * wrapping row of small bordered pills above the grid — never as a card, never
 * taking a grid cell.
 *
 * ### Dependent filters
 *
 * A child's options are constrained by the parent's selection — Country then
 * City, Category then Sub-category. Metabase resolves this from table metadata
 * and FK chains, which we have no equivalent of and do not need:
 *
 * ```tsx
 * const country = useParam({ id: 'country', ... });
 * const cities  = usePanelData('cities', { country });   // re-runs on change
 * <FilterChoice param={city} optionsFrom={cities} valueColumn="city" />
 * ```
 *
 * The dependency is the parameter binding that already exists. Nothing here
 * knows what a foreign key is, and a chain of any depth works because each link
 * is an ordinary resolver call.
 *
 * What happens to the child's selection when the parent invalidates it is
 * answered in `useValidSelection` — see `shared.tsx`.
 */
export { FilterBar, FilterGroup } from './bar';
export { FilterChoice, type FilterChoiceProps } from './choice';
export { FilterSearch, type FilterSearchProps } from './search';
export { FilterMultiChoice, type FilterMultiChoiceProps } from './multi-choice';
export { FilterDate } from './date';
export { FilterDateRange } from './date-range';
export { FilterRange } from './range';
export { FilterToggle } from './toggle';
