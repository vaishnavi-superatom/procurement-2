# ikea Database Schema

**Description:** Ikea Database (POSTGRESQL) - Generated on 2026-02-05T17:41:18.597251

## Overview

- **Database:** ikea
- **Database Type:** POSTGRESQL
- **Schema:** public
- **Total Tables:** 10
- **Total Rows:** 198,441

## Tables

- [addresses](#addresses) - Shipping and billing addresses (3,404 rows)
- [categories](#categories) - Category hierarchy (17 rows)
- [customers](#customers) - Customer master data and profiles (3,500 rows)
- [inventory](#inventory) - Product inventory levels (118,004 rows)
- [locations](#locations) - Store and warehouse locations (54 rows)
- [order_items](#order_items) - Individual line items within orders (44,674 rows)
- [orders](#orders) - Customer orders and transactions (20,000 rows)
- [product_variants](#product_variants) - Junction table linking product and variants (2,962 rows)
- [products](#products) - Product master catalog (826 rows)
- [reviews](#reviews) - Customer reviews and ratings (5,000 rows)

---

## addresses

**Description:** Shipping and billing addresses

**Row Count:** 3,404

### Columns

| Column | Type | Nullable | Key | Description |
|--------|------|----------|-----|-------------|
| address_id | integer | No | PK | Primary key for addresse |
| customer_id | integer | No | FK -> customers | Reference to customers |
| street | text | Yes |  | Street address |
| city | character varying | Yes |  | City name |
| postal_code | character varying | Yes |  | Postal/ZIP code |
| country | character varying | Yes |  | Country |
| is_default | boolean | Yes |  | Whether default |
| created_at | timestamp without time zone | Yes |  | Timestamp when record was created |
| updated_at | timestamp without time zone | Yes |  | Timestamp when record was last updated |

### Statistics

**address_id:**
- Distinct values: 3,404
- Min: 2.0
- Max: 5110.0

**customer_id:**
- Distinct values: 1,293
- Min: 2.0
- Max: 2000.0

**street:**
- Distinct values: 3,404

**city:**
- Distinct values: 54

**postal_code:**
- Distinct values: 3,333

**country:**
- Distinct values: 1
- Sample values: United States

**created_at:**
- Distinct values: 2
- Sample values: 2025-10-29 08:44:14.051089, 2025-10-29 08:46:26.877375

**updated_at:**
- Distinct values: 2
- Sample values: 2025-10-29 08:44:14.051089, 2025-10-29 08:46:26.877375

---

## categories

**Description:** Category hierarchy

**Row Count:** 17

### Columns

| Column | Type | Nullable | Key | Description |
|--------|------|----------|-----|-------------|
| category_id | integer | No | PK | Primary key for categorie |
| name | character varying | No |  | Name or title |
| parent_id | integer | Yes | FK -> categories | Reference to categories |
| created_at | timestamp without time zone | Yes |  | Timestamp when record was created |
| updated_at | timestamp without time zone | Yes |  | Timestamp when record was last updated |

### Statistics

**category_id:**
- Distinct values: 17
- Min: 1.0
- Max: 17.0

**name:**
- Distinct values: 17

**parent_id:**
- Distinct values: 0

**created_at:**
- Distinct values: 1
- Sample values: 2025-10-29 06:24:21.168607

**updated_at:**
- Distinct values: 1
- Sample values: 2025-10-29 06:24:21.168607

---

## customers

**Description:** Customer master data and profiles

**Row Count:** 3,500

### Columns

| Column | Type | Nullable | Key | Description |
|--------|------|----------|-----|-------------|
| customer_id | integer | No | PK | Primary key for customer |
| email | character varying | No |  | Email address |
| first_name | character varying | Yes |  | First name |
| last_name | character varying | Yes |  | Last name |
| phone | character varying | Yes |  | Phone number |
| is_loyalty_member | boolean | Yes |  | Whether loyalty member |
| created_at | timestamp without time zone | Yes |  | Timestamp when record was created |
| updated_at | timestamp without time zone | Yes |  | Timestamp when record was last updated |

### Statistics

**customer_id:**
- Distinct values: 3,500
- Min: 2.0
- Max: 7555.0

**email:**
- Distinct values: 3,500

**first_name:**
- Distinct values: 120

**last_name:**
- Distinct values: 100

**phone:**
- Distinct values: 3,500

**created_at:**
- Distinct values: 2
- Sample values: 2025-10-29 08:44:05.636186, 2025-10-30 04:18:40.313719

**updated_at:**
- Distinct values: 2
- Sample values: 2025-10-29 08:44:05.636186, 2025-10-30 04:18:40.313719

---

## inventory

**Description:** Product inventory levels

**Row Count:** 118,004

### Columns

| Column | Type | Nullable | Key | Description |
|--------|------|----------|-----|-------------|
| inventory_id | integer | No | PK | Primary key for inventory |
| variant_id | integer | No |  | Reference to Variant |
| location_id | integer | No | FK -> locations | Reference to locations |
| quantity_available | integer | Yes |  | Quantity Available |
| last_updated | timestamp without time zone | Yes |  | Last Updated |

### Statistics

**inventory_id:**
- Distinct values: 118,004
- Min: 1.0
- Max: 118004.0

**variant_id:**
- Distinct values: 2,962
- Min: 1.0
- Max: 2962.0

**location_id:**
- Distinct values: 54
- Min: 1.0
- Max: 54.0

**quantity_available:**
- Distinct values: 299
- Min: 0.0
- Max: 319.0

**last_updated:**
- Distinct values: 1
- Sample values: 2025-10-29 07:26:41.413631

---

## locations

**Description:** Store and warehouse locations

**Row Count:** 54

### Columns

| Column | Type | Nullable | Key | Description |
|--------|------|----------|-----|-------------|
| location_id | integer | No | PK | Primary key for location |
| location_name | character varying | Yes |  | Location name |
| location_type | character varying | Yes |  | Location type |
| city | character varying | Yes |  | City name |
| country | character varying | Yes |  | Country |
| created_at | timestamp without time zone | Yes |  | Timestamp when record was created |
| opening_hours | character varying | Yes |  | Opening Hours |
| store_url | text | Yes |  | URL for store |
| updated_at | timestamp without time zone | Yes |  | Timestamp when record was last updated |
| state | character varying | Yes |  | State or province |

### Statistics

**location_id:**
- Distinct values: 54
- Min: 1.0
- Max: 54.0

**location_name:**
- Distinct values: 54

**location_type:**
- Distinct values: 2
- Sample values: Full-size Store, Small Store

**city:**
- Distinct values: 54

**country:**
- Distinct values: 1
- Sample values: United States

**created_at:**
- Distinct values: 1
- Sample values: 2025-10-29 06:40:01.598849

**opening_hours:**
- Distinct values: 2
- Sample values: Mon–Sun 10 AM–8 PM, Mon–Sun 10 AM–9 PM

**store_url:**
- Distinct values: 54

**updated_at:**
- Distinct values: 1
- Sample values: 2025-10-29 06:40:01.598849

**state:**
- Distinct values: 27

---

## order_items

**Description:** Individual line items within orders

**Row Count:** 44,674

### Columns

| Column | Type | Nullable | Key | Description |
|--------|------|----------|-----|-------------|
| order_item_id | integer | No | PK | Primary key for order item |
| order_id | integer | No | FK -> orders | Reference to orders |
| variant_id | integer | No |  | Reference to Variant |
| quantity | integer | No |  | Quantity |
| price_at_purchase | numeric | Yes |  | Price At Purchase |

### Statistics

**order_item_id:**
- Distinct values: 44,674
- Min: 1.0
- Max: 44674.0

**order_id:**
- Distinct values: 10,000
- Min: 1.0
- Max: 10000.0

**variant_id:**
- Distinct values: 2,961
- Min: 1.0
- Max: 2962.0

**quantity:**
- Distinct values: 3
- Min: 1.0
- Max: 3.0
- Sample values: 1, 2, 3

**price_at_purchase:**
- Distinct values: 978
- Min: 3.0
- Max: 9585.0

---

## orders

**Description:** Customer orders and transactions

**Row Count:** 20,000

### Columns

| Column | Type | Nullable | Key | Description |
|--------|------|----------|-----|-------------|
| order_id | integer | No | PK | Primary key for order |
| customer_id | integer | No | FK -> customers | Reference to customers |
| shipping_address_id | integer | Yes | FK -> addresses | Reference to addresses |
| order_date | timestamp without time zone | Yes |  | Date when order was placed |
| total_amount | numeric | Yes |  | Total amount |
| status | character varying | Yes |  | Current status |
| payment_method | character varying | Yes |  | Payment Method |
| created_at | timestamp without time zone | Yes |  | Timestamp when record was created |
| updated_at | timestamp without time zone | Yes |  | Timestamp when record was last updated |
| store_id | integer | Yes | FK -> locations | Reference to locations |
| delivery_method | character varying | Yes |  | Delivery Method |
| pickup_store_id | integer | Yes | FK -> locations | Reference to locations |
| delivery_fee | numeric | Yes |  | Delivery fee |
| cancellation_reason | text | Yes |  | Cancellation Reason |
| failure_reason | text | Yes |  | Failure Reason |
| cancelled_at | timestamp without time zone | Yes |  | Cancellation timestamp |
| failed_at | timestamp without time zone | Yes |  | Failure timestamp |

### Statistics

**order_id:**
- Distinct values: 20,000
- Min: 1.0
- Max: 20000.0

**customer_id:**
- Distinct values: 3,500
- Min: 2.0
- Max: 7555.0

**shipping_address_id:**
- Distinct values: 2,518
- Min: 2.0
- Max: 5110.0

**order_date:**
- Distinct values: 1,462

**total_amount:**
- Distinct values: 9,155
- Min: 3.0
- Max: 37983.93

**status:**
- Distinct values: 6
- Sample values: Cancelled, Delivered, Failed, Pending, Processing, Shipped

**payment_method:**
- Distinct values: 4
- Sample values: Apple Pay, Credit Card, Debit Card, PayPal

**created_at:**
- Distinct values: 2
- Sample values: 2025-10-29 08:44:20.411739, 2025-10-29 08:46:31.357422

**updated_at:**
- Distinct values: 11
- Sample values: 2025-10-29 08:44:20.411739, 2025-10-29 08:46:31.357422, 2025-10-31 16:21:45.893407, 2025-10-31 18:04:43.630778, 2025-10-31 19:09:37.949536, 2025-11-01 01:14:39.758504, 2025-11-01 01:59:03.328413, 2025-11-25 21:36:52.118980, 2025-11-27 13:27:33.626120, 2025-11-27 13:39:07.004077

**store_id:**
- Distinct values: 54
- Min: 1.0
- Max: 54.0

**delivery_method:**
- Distinct values: 3
- Sample values: click_and_collect, home_delivery, in_store_purchase

**pickup_store_id:**
- Distinct values: 54
- Min: 1.0
- Max: 54.0

**delivery_fee:**
- Distinct values: 4,265
- Min: 0.0
- Max: 89.99

**cancellation_reason:**
- Distinct values: 10
- Sample values: Customer request - changed mind, Customer request - found better price, Customer request - ordered wrong item, Customer unreachable, Delivery address invalid, Duplicate order, null, Out of stock - unavailable, Payment failed - declined card, Payment failed - insufficient funds

**failure_reason:**
- Distinct values: 7
- Sample values: Delivery failed - access issues, Delivery failed - customer unavailable, Item damaged in transit, Lost in shipping, null, Payment processing error, System error during processing

**cancelled_at:**
- Distinct values: 269

**failed_at:**
- Distinct values: 97

---

## product_variants

**Description:** Junction table linking product and variants

**Row Count:** 2,962

### Columns

| Column | Type | Nullable | Key | Description |
|--------|------|----------|-----|-------------|
| variant_id | integer | No | PK | Primary key for product variant |
| product_id | integer | No | FK -> products | Reference to products |
| item_id | character varying | No |  | Reference to Item |
| color | character varying | Yes |  | Color |
| price | numeric | Yes |  | Price |
| old_price | numeric | Yes |  | Old price |
| other_colors | character varying | Yes |  | Other Colors |
| depth_cm | numeric | Yes |  | Depth Cm |
| height_cm | numeric | Yes |  | Height Cm |
| width_cm | numeric | Yes |  | Width Cm |
| stock_quantity | integer | Yes |  | Stock Quantity |
| is_active | boolean | Yes |  | Whether active |
| variant_link | text | Yes |  | Link to variant |
| created_at | timestamp without time zone | Yes |  | Timestamp when record was created |
| updated_at | timestamp without time zone | Yes |  | Timestamp when record was last updated |
| article_number | character varying | Yes |  | Article number |
| images | jsonb | Yes |  | Images (JSON) |
| discount_percent | integer | Yes |  | Discount Percent |

### Statistics

**variant_id:**
- Distinct values: 2,962
- Min: 1.0
- Max: 2962.0

**product_id:**
- Distinct values: 826
- Min: 1.0
- Max: 826.0

**item_id:**
- Distinct values: 2,962

**color:**
- Distinct values: 17
- Sample values: Anthracite, Beige, Birch, Black, Blue, Brown, Chrome, Green, Grey, Oak

**price:**
- Distinct values: 979
- Min: 3.0
- Max: 9585.0

**old_price:**
- Distinct values: 359
- Min: 7.0
- Max: 9985.0

**other_colors:**
- Distinct values: 2
- Sample values: No, Yes

**depth_cm:**
- Distinct values: 114
- Min: 1.0
- Max: 257.0

**height_cm:**
- Distinct values: 193
- Min: 1.0
- Max: 700.0

**width_cm:**
- Distinct values: 263
- Min: 1.0
- Max: 420.0

**stock_quantity:**
- Distinct values: 1
- Min: 0.0
- Max: 0.0
- Sample values: 0

**variant_link:**
- Distinct values: 2,962

**created_at:**
- Distinct values: 1
- Sample values: 2025-10-29 06:24:29.657002

**updated_at:**
- Distinct values: 1
- Sample values: 2025-10-29 06:24:29.657002

**article_number:**
- Distinct values: 0

**discount_percent:**
- Distinct values: 38
- Min: 0.0
- Max: 50.0

---

## products

**Description:** Product master catalog

**Row Count:** 826

### Columns

| Column | Type | Nullable | Key | Description |
|--------|------|----------|-----|-------------|
| product_id | integer | No | PK | Primary key for product |
| name | text | No |  | Name or title |
| short_description | text | Yes |  | Short Description |
| designer | text | Yes |  | Designer |
| category_id | integer | Yes | FK -> categories | Reference to categories |
| sellable_online | boolean | Yes |  | Boolean flag for sellable online |
| base_link | text | Yes |  | Link to base |
| created_at | timestamp without time zone | Yes |  | Timestamp when record was created |
| updated_at | timestamp without time zone | Yes |  | Timestamp when record was last updated |

### Statistics

**product_id:**
- Distinct values: 826
- Min: 1.0
- Max: 826.0

**name:**
- Distinct values: 607

**short_description:**
- Distinct values: 581

**designer:**
- Distinct values: 229

**category_id:**
- Distinct values: 17
- Min: 1.0
- Max: 17.0
- Sample values: 1, 2, 3, 4, 5, 6, 7, 8, 9, 10

**base_link:**
- Distinct values: 826

**created_at:**
- Distinct values: 1
- Sample values: 2025-10-29 06:24:22.542022

**updated_at:**
- Distinct values: 1
- Sample values: 2025-10-29 06:24:22.542022

---

## reviews

**Description:** Customer reviews and ratings

**Row Count:** 5,000

### Columns

| Column | Type | Nullable | Key | Description |
|--------|------|----------|-----|-------------|
| review_id | integer | No | PK | Primary key for review |
| customer_id | integer | No | FK -> customers | Reference to customers |
| product_id | integer | No |  | Reference to Product |
| rating | integer | Yes |  | Rating |
| comment | text | Yes |  | Comment text |
| review_date | timestamp without time zone | Yes |  | Review date |

### Statistics

**review_id:**
- Distinct values: 5,000
- Min: 1.0
- Max: 5000.0

**customer_id:**
- Distinct values: 2,032
- Min: 2.0
- Max: 7555.0

**product_id:**
- Distinct values: 733
- Min: 1.0
- Max: 825.0

**rating:**
- Distinct values: 5
- Min: 1.0
- Max: 5.0
- Sample values: 1, 2, 3, 4, 5

**comment:**
- Distinct values: 2,750

**review_date:**
- Distinct values: 761

---

## Relationships

| From Table | To Table | Type | Foreign Key |
|------------|----------|------|-------------|
| addresses | customers | many-to-one | customer_id -> customer_id |
| categories | categories | many-to-one | parent_id -> category_id |
| inventory | locations | many-to-one | location_id -> location_id |
| order_items | orders | many-to-one | order_id -> order_id |
| orders | customers | many-to-one | customer_id -> customer_id |
| orders | locations | many-to-one | pickup_store_id -> location_id |
| orders | addresses | many-to-one | shipping_address_id -> address_id |
| orders | locations | many-to-one | store_id -> location_id |
| product_variants | products | many-to-one | product_id -> product_id |
| products | categories | many-to-one | category_id -> category_id |
| reviews | customers | many-to-one | customer_id -> customer_id |

## Common Queries

### 1. Total addresses count

```sql
SELECT COUNT(*) as total FROM addresses;
```

### 2. Addresses by month

```sql
SELECT DATE_TRUNC('month', created_at) as month, COUNT(*) as count FROM addresses GROUP BY month ORDER BY month DESC;
```

### 3. Total categories count

```sql
SELECT COUNT(*) as total FROM categories;
```

### 4. Categories by month

```sql
SELECT DATE_TRUNC('month', created_at) as month, COUNT(*) as count FROM categories GROUP BY month ORDER BY month DESC;
```

### 5. Total customers count

```sql
SELECT COUNT(*) as total FROM customers;
```

### 6. Customers by month

```sql
SELECT DATE_TRUNC('month', created_at) as month, COUNT(*) as count FROM customers GROUP BY month ORDER BY month DESC;
```

### 7. Total inventory count

```sql
SELECT COUNT(*) as total FROM inventory;
```

### 8. Total locations count

```sql
SELECT COUNT(*) as total FROM locations;
```

### 9. Locations by month

```sql
SELECT DATE_TRUNC('month', created_at) as month, COUNT(*) as count FROM locations GROUP BY month ORDER BY month DESC;
```

### 10. Total order_items count

```sql
SELECT COUNT(*) as total FROM order_items;
```

### 11. Total orders count

```sql
SELECT COUNT(*) as total FROM orders;
```

### 12. Orders by status

```sql
SELECT status, COUNT(*) as count FROM orders GROUP BY status ORDER BY count DESC;
```

### 13. Orders by month

```sql
SELECT DATE_TRUNC('month', order_date) as month, COUNT(*) as count FROM orders GROUP BY month ORDER BY month DESC;
```

### 14. Total orders total amount

```sql
SELECT SUM(total_amount) as total FROM orders;
```

### 15. Total product_variants count

```sql
SELECT COUNT(*) as total FROM product_variants;
```

