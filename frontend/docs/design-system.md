# AdminDesk Design System

## Overview
A modern, professional design system for sales management and analytics dashboards. Built with **Tailwind CSS** for styling and **Apache ECharts** for data visualization.

---

## Color Palette

### Primary Colors
- **Primary Blue**: `#4A7FFF` - Main brand color, used for primary actions, active states, and key highlights
- **Dark Navy**: `#1E293B` to `#2D3748` - Sidebar background (gradient), primary text, dark elements
- **Light Background**: `#F8F9FB` - Main content area background

### Functional Colors
- **Success Green**: `#4ADE80` - Positive metrics, growth indicators, success messages
- **Warning Orange**: `#FB923C` - Alerts, warning states, attention indicators
- **Error/Expense Red**: `#FF6B4A` - Errors, expense data, negative metrics
- **Info Yellow**: `#FBBF24` - Information badges, highlights

### Text Colors
- **Primary Text**: `#1E293B` - Headings, important text, main content
- **Secondary Text**: `#64748B` - Supporting text, labels, descriptions
- **Tertiary Text**: `#94A3B8` - Disabled text, placeholders, inactive states
- **White Text**: `#FFFFFF` - Text on dark backgrounds

### UI Colors
- **White**: `#FFFFFF` - Cards, elevated surfaces, content backgrounds
- **Light Gray**: `#F1F5F9` - Hover states, subtle backgrounds
- **Border Gray**: `#E2E8F0` - Dividers, borders, separators

### Chart Colors
- **Earning/Positive**: `#4A7FFF` (Primary Blue)
- **Expense/Negative**: `#FF6B4A` (Orange-Red)
- **Secondary Data**: `#C084FC` (Purple)
- **Tertiary Data**: `#22D3EE` (Cyan)

---

## Typography

### Font Family
- **Primary Font**: Inter (with system fallbacks: -apple-system, BlinkMacSystemFont, "Segoe UI")
- **Monospace Font**: SF Mono, Monaco, Cascadia Code (for numerical data and code)

### Font Sizes
- **Hero Numbers**: 48px (3rem) - Large dashboard statistics
- **Page Title**: 32px (2rem) - Main page headings
- **Section Headers**: 24px (1.5rem) - Card titles, section headers
- **Subsection Headers**: 20px (1.25rem) - Minor headings
- **Body Large**: 16px (1rem) - Primary content, important text
- **Body Regular**: 14px (0.875rem) - Standard text, most UI elements
- **Small Text**: 12px (0.75rem) - Labels, captions, secondary info
- **Tiny Text**: 10px (0.625rem) - Badges, timestamps, micro-text

### Font Weights
- **Regular (400)**: Body text, standard content
- **Medium (500)**: Emphasized text, buttons
- **Semibold (600)**: Headings, labels, important UI text
- **Bold (700)**: Hero numbers, statistics, strong emphasis

### Line Heights
- Headings: 1.1 to 1.3
- Body text: 1.5 to 1.6
- Compact UI: 1.4

---

## Spacing System

Use an 8px-based grid system:

- **4px (0.5)**: Tight spacing between closely related elements
- **8px (1)**: Compact spacing, gaps within components
- **12px (1.5)**: Small spacing
- **16px (2)**: Standard spacing between elements
- **24px (3)**: Medium spacing between sections
- **32px (4)**: Large spacing, section separators
- **48px (6)**: Extra large spacing between major sections
- **64px (8)**: Maximum spacing for layout separation

---

## Border Radius

- **Small (4px)**: Badges, pills, small tags
- **Medium (8px)**: Buttons, input fields, small cards
- **Large (12px)**: Main cards, panels, containers
- **Extra Large (16px)**: Modals, large containers, overlays
- **Circle (50%)**: Avatar images, icon backgrounds, circular elements

---

## Shadows & Elevation

### Shadow Levels
- **Level 1 (Card)**: Subtle shadow for cards - `0 1px 3px rgba(0, 0, 0, 0.1)`
- **Level 2 (Dropdown)**: Medium shadow for dropdowns - `0 4px 6px rgba(0, 0, 0, 0.1)`
- **Level 3 (Modal)**: Strong shadow for modals - `0 10px 15px rgba(0, 0, 0, 0.1)`
- **Level 4 (Overlay)**: Heavy shadow for overlays - `0 20px 25px rgba(0, 0, 0, 0.1)`

### Hover States
- Increase elevation slightly on hover for interactive elements
- Cards can lift from Level 1 to Level 2 on hover

---

## Layout & Grid

### Container
- **Max Width**: 1440px
- **Padding**: 24px (mobile), 32px (tablet), 48px (desktop)
- **Centered**: Auto margins

### Sidebar
- **Width**: 224px (fixed)
- **Background**: Linear gradient from `#2D3748` to `#1E293B`
- **Padding**: 24px horizontal, 16px vertical

### Main Content Area
- **Padding**: 32px
- **Background**: `#F8F9FB`
- **Gap between cards**: 24px

### Grid System
- **Columns**: 4 columns for stat cards on desktop, 2 on tablet, 1 on mobile
- **Gap**: 24px between grid items

### Responsive Breakpoints
- **Mobile**: 320px - 767px
- **Tablet**: 768px - 1023px
- **Desktop**: 1024px and above

---

## Component Specifications

### 1. Stat Cards (Metric Cards)
- **Background**: White
- **Border Radius**: 12px (large)
- **Padding**: 24px
- **Border**: 4px solid accent color on left edge
- **Shadow**: Level 1 card shadow
- **Icon Background**: 56px × 56px circle, 10-15% opacity of the accent color
- **Icon Size**: 28px
- **Value**: 24px, Bold (700), Dark navy color
- **Label**: 14px, Medium (500), Secondary text color
- **Trend Indicator**: Small icon (16px) with percentage, green for positive, red for negative

### 2. Cards
- **Background**: White
- **Border Radius**: 12px
- **Padding**: 24px (16px on mobile)
- **Shadow**: Level 1
- **Border**: Optional 1px solid border gray
- **Title**: 18px, Semibold, Dark navy
- **Content Padding**: 16px internal spacing

### 3. Buttons

**Primary Button**
- **Background**: Primary blue `#4A7FFF`
- **Text Color**: White
- **Padding**: 10px × 20px
- **Border Radius**: 8px (medium)
- **Font Weight**: Medium (500)
- **Font Size**: 14px
- **Hover**: Darken by 10% (`#4C6EF5` to `#4338CA`)
- **Active**: Slight scale down (98%)
- **Transition**: 200ms ease

**Secondary Button**
- **Background**: Transparent
- **Text Color**: Primary blue
- **Border**: 1px solid primary blue
- **Padding**: 10px × 20px
- **Border Radius**: 8px
- **Hover**: Light blue background (`#EEF2FF`)

**Ghost Button**
- **Background**: Transparent
- **Text Color**: Secondary text color
- **No Border**
- **Padding**: 10px × 20px
- **Border Radius**: 8px
- **Hover**: Light gray background (`#F1F5F9`)

### 4. Sidebar Navigation Items
- **Height**: 40px
- **Padding**: 8px × 12px
- **Border Radius**: 8px
- **Font Size**: 14px
- **Font Weight**: Medium (500)
- **Icon Size**: 20px
- **Gap**: 12px between icon and text

**Inactive State**
- **Text Color**: `#94A3B8` (tertiary)
- **Background**: Transparent
- **Hover**: White overlay at 5% opacity

**Active State**
- **Background**: Primary blue
- **Text Color**: White

**Badge (for Messages)**
- **Background**: Error red
- **Text**: White, 11px, Bold
- **Padding**: 4px × 8px
- **Border Radius**: Full (50%)

### 5. Tables

**Table Header**
- **Background**: `#F8F9FB`
- **Text**: 12px, Semibold, Secondary color, Uppercase
- **Padding**: 12px × 16px
- **Border Bottom**: 1px solid border gray

**Table Rows**
- **Padding**: 16px
- **Border Bottom**: 1px solid border gray
- **Font Size**: 14px
- **Text Color**: Primary text
- **Hover**: Light gray background

**Table Cells**
- Vertically centered alignment
- Proper text alignment (left for text, right for numbers)

### 6. Badges
- **Padding**: 4px × 8px
- **Border Radius**: 12px (pill shape)
- **Font Size**: 11px
- **Font Weight**: Semibold (600)
- **Background**: Status color at 10% opacity
- **Text**: Full saturation status color

### 7. Icons
- **Default Size**: 20px
- **Small**: 16px
- **Large**: 24px
- **Stat Card Icons**: 28px
- **Stroke Width**: 2px
- **Icon Library**: Use Iconify icons (via @iconify/react) for consistency and extensive icon options
- **Style**: Line icons with rounded corners preferred

### 8. Date Picker / Dropdowns
- **Border**: 1px solid border gray
- **Border Radius**: 8px
- **Padding**: 8px × 12px
- **Font Size**: 14px
- **Background**: White
- **Hover**: Light gray border
- **Focus**: Primary blue border

---

## Chart Specifications (Apache ECharts)

### General Chart Settings
- **Background**: Transparent
- **Font Family**: Inter
- **Font Size**: 14px for labels, 12px for axis
- **Color Palette**: Use the defined chart colors in sequence
- **Smooth Curves**: Enable for line charts
- **Animation**: 500ms ease-out on load

### Donut Chart
- **Inner Radius**: 40%
- **Outer Radius**: 70%
- **Gap Between Segments**: 2px white border
- **Border Radius**: 10px for segments
- **Colors**: Primary blue `#4A7FFF`, Success green `#4ADE80`, Warning orange `#FB923C`, Purple `#C084FC`, Cyan `#22D3EE`, Error red `#FF6B4A`, Info yellow `#FBBF24`
- **Legend**: Bottom position, 12px font size, secondary text color `#64748B`, circle icons (8px)
- **Hover Effect**: Show label with bold font

### Bar Chart (Reports)
- **Bar Width**: 16px maximum
- **Bar Gap**: 24px between groups
- **Border Radius**: 4px on top corners only
- **Colors**: Blue for positive/earning, Orange-red for negative/expense
- **Grid Lines**: Dashed, light gray `#E2E8F0`
- **Y-Axis**: Show, with values
- **X-Axis**: Show month abbreviations (Jan, Feb, etc.)

### Line Chart (Budget Trend)
- **Line Width**: 2px
- **Point Size**: 6px circles
- **Smooth**: Yes
- **Area Fill**: 20% opacity of line color
- **Colors**: Purple `#C084FC` for main line
- **Grid Lines**: Dashed, light gray

### Chart Legends
- **Position**: Top right
- **Icon**: Circle (8px)
- **Font Size**: 12px
- **Text Color**: Secondary text
- **Gap**: 16px between legend items

### Tooltips
- **Background**: Dark navy `#1E293B`
- **Text Color**: White
- **Padding**: 12px × 16px
- **Border Radius**: 8px
- **Font Size**: 14px
- **No Border**

---

## Interactions & Animations

### Transition Durations
- **Fast**: 150ms - Small state changes
- **Default**: 200ms - Most interactions
- **Slow**: 300ms - Complex animations
- **Timing Function**: ease-in-out

### Hover States
- **Buttons**: Darken background by 10%
- **Cards**: Increase shadow from Level 1 to Level 2
- **Navigation Items**: Show subtle background overlay
- **Table Rows**: Light gray background
- **Links**: Underline or color change

### Active/Pressed States
- **Buttons**: Scale down to 98%
- **Links**: Slight opacity reduction

### Focus States
- **Inputs**: Primary blue border (2px)
- **Buttons**: Primary blue outline with 2px offset

---

## Data Formatting Guidelines

### Numbers
- **Currency**: Use dollar sign with comma separators ($58,947)
- **Percentages**: 2 decimal places maximum (0.58%)
- **Large Numbers**: Use K for thousands, M for millions (78.41k, 2.5M)
- **Small Numbers**: Show full number with commas (1,234)

### Dates
- **Format**: MM-DD-YYYY (10-06-2022)
- **Alternative**: Month abbreviation (Jan, Feb, Mar)
- **Relative**: "in 2 days", "in 24 hours"

### Status Indicators
- **Percentage Growth**: Green up arrow icon + positive number
- **Percentage Decline**: Red down arrow icon + negative number
- **Neutral**: Gray indicator
- **Position**: Right-aligned or next to the metric

---

## Accessibility Guidelines

### Color Contrast
- **Primary Text**: Must have 4.5:1 contrast ratio with background
- **Secondary Text**: Should maintain readability
- **UI Elements**: 3:1 contrast ratio minimum
- **CRITICAL RULE**: Never use text and background colors that are the same or matching. Always ensure sufficient contrast between text and its background for readability and accessibility

### Interactive Elements
- **Touch Targets**: Minimum 44px × 44px for mobile
- **Focus Indicators**: Always visible for keyboard navigation
- **ARIA Labels**: Use for icon-only buttons and complex widgets

### Typography
- **Minimum Size**: 12px for body text, 14px preferred
- **Line Length**: Maximum 80 characters per line for readability
- **Line Height**: 1.5 minimum for body text

---

## Best Practices

1. **Consistency**: Always use the defined color palette and spacing system
2. **Hierarchy**: Use font sizes and weights to establish clear visual hierarchy
3. **White Space**: Don't be afraid of empty space - it improves readability
4. **Responsive**: Design mobile-first, scale up for larger screens
5. **Performance**: Optimize chart rendering, dispose instances properly
6. **Feedback**: Provide visual feedback for all interactive elements
7. **Loading States**: Show skeleton loaders or spinners for async data
8. **Error Handling**: Use clear error messages with actionable solutions
9. **Color Contrast**: NEVER use matching or same colors for text and background - always ensure proper contrast
10. **Icons**: Use Iconify (@iconify/react) for all icon needs to maintain consistency across the application
11. **TypeScript**: Always declare proper types for variables, function parameters, and return values - avoid using `any` type
12. **Loading Skeleton Color**: Use `#E2E8F0` (border gray) for skeleton loaders to ensure they are visible and distinguishable from background

---

## Component Design Expectations

### KPI Cards
- **Top accent bar**: 1px colored bar at the top instead of thick left borders
- **Border with hover**: Light border (`#E2E8F0`) that changes to primary blue (`#4A7FFF`) on hover
- **Icon placement**: Small rounded square icon (40×40px) positioned next to title at the top
- **Icon background**: Use 20% opacity of the accent color
- **Value size**: Large and bold (3xl/48px) for primary metric
- **Trend indicators**:
  - Pill-shaped badges with 10% opacity background
  - Use trending-up/down icons from Iconify
  - Include context text like "vs last period"
- **Loading states**: Use darker skeleton color (`#E2E8F0`) with pulse animation
- **Error states**: Show icon with descriptive error message
- **Hover effects**: Elevate shadow and change border color smoothly

### Module Structure
- All reusable components should be in `modules/[ComponentName]/index.tsx`
- Each module must accept data via props (especially SQL queries)
- Use `executeQuery()` function from `utils/database.ts` to fetch data
- Handle loading, error, and success states gracefully
- Make most props optional with sensible defaults

### Data Fetching
- Always wait for WebSocket connection before executing queries
- Handle nested data structures properly (e.g., `result.data.data`)
- Use proper TypeScript types for API responses
- Show loading states during data fetching
- Display user-friendly error messages on failure