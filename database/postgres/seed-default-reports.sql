-- =============================================================================
-- Default Reports for IKEA Dataset
-- Seeded during setup for CIO/CTO demo experience
-- Uses :project_id psql variable for project association
-- =============================================================================

-- Clean up existing default reports for this project (idempotent)
DELETE FROM reports WHERE report_id IN (
    'ikea-weekly-business-summary',
    'ikea-monthly-revenue-growth',
    'ikea-customer-loyalty-report',
    'ikea-inventory-risk-report',
    'ikea-fulfillment-quality-report'
) AND project_id = :project_id;

-- Report 1: Weekly Business Summary
INSERT INTO reports (report_id, project_id, name, description, report, published)
VALUES (
    'ikea-weekly-business-summary',
    :project_id,
    'Weekly Business Summary',
    'Executive brief on this week''s business performance — revenue, orders, top categories, and key transactions',
    $json${
  "dsl": {
    "id": "weekly-business-summary",
    "name": "Weekly Business Summary",
    "render": {
      "id": "root",
      "type": "MultiComponentContainer",
      "props": {
        "config": {
          "layout": "vertical",
          "components": [
            {
              "id": "md-weekly-header",
              "type": "MarkdownBlock",
              "name": "DynamicMarkdownBlock",
              "props": {
                "content": "# Weekly Business Summary\n\n**Prepared by:** Business Intelligence Team\n\n---\n\n## Executive Summary\n\nThis report provides a snapshot of business performance for the current week. Revenue, order volume, customer acquisition, and average order value are tracked to identify short-term trends and operational highlights.\n\n> **Key Takeaway:** Weekly monitoring enables rapid response to emerging trends and ensures alignment with monthly and quarterly targets."
              }
            },
            {
              "id": "kpi-week-revenue",
              "type": "KPICard",
              "name": "DynamicKPICard",
              "props": {
                "query": null,
                "externalTool": {
                  "toolId": "__IKEA_TOOL_ID__",
                  "toolName": "__IKEA_TOOL_NAME__",
                  "parameters": {
                    "sql": "SELECT SUM(total_amount) as value FROM orders WHERE order_date >= DATE_TRUNC('week', CURRENT_DATE) AND status NOT IN ('Cancelled', 'Failed')"
                  }
                },
                "title": "This Week Revenue",
                "description": "Revenue generated in the current week",
                "config": {
                  "valueKey": "value",
                  "prefix": "$",
                  "formatNumber": true,
                  "icon": "mdi:currency-usd",
                  "iconColor": "#22c55e"
                }
              }
            },
            {
              "id": "kpi-week-orders",
              "type": "KPICard",
              "name": "DynamicKPICard",
              "props": {
                "query": null,
                "externalTool": {
                  "toolId": "__IKEA_TOOL_ID__",
                  "toolName": "__IKEA_TOOL_NAME__",
                  "parameters": {
                    "sql": "SELECT COUNT(*) as value FROM orders WHERE order_date >= DATE_TRUNC('week', CURRENT_DATE) AND status NOT IN ('Cancelled', 'Failed')"
                  }
                },
                "title": "This Week Orders",
                "description": "Orders placed in the current week",
                "config": {
                  "valueKey": "value",
                  "formatNumber": true,
                  "icon": "mdi:cart-outline",
                  "iconColor": "#6366f1"
                }
              }
            },
            {
              "id": "kpi-week-new-customers",
              "type": "KPICard",
              "name": "DynamicKPICard",
              "props": {
                "query": null,
                "externalTool": {
                  "toolId": "__IKEA_TOOL_ID__",
                  "toolName": "__IKEA_TOOL_NAME__",
                  "parameters": {
                    "sql": "SELECT COUNT(*) as value FROM customers WHERE created_at >= DATE_TRUNC('week', CURRENT_DATE)"
                  }
                },
                "title": "New Customers",
                "description": "Customer registrations this week",
                "config": {
                  "valueKey": "value",
                  "formatNumber": true,
                  "icon": "mdi:account-plus",
                  "iconColor": "#8B5CF6"
                }
              }
            },
            {
              "id": "kpi-week-avg-order",
              "type": "KPICard",
              "name": "DynamicKPICard",
              "props": {
                "query": null,
                "externalTool": {
                  "toolId": "__IKEA_TOOL_ID__",
                  "toolName": "__IKEA_TOOL_NAME__",
                  "parameters": {
                    "sql": "SELECT ROUND(AVG(total_amount), 2) as value FROM orders WHERE order_date >= DATE_TRUNC('week', CURRENT_DATE) AND status NOT IN ('Cancelled', 'Failed')"
                  }
                },
                "title": "Avg Order Value",
                "description": "Average order value this week",
                "config": {
                  "valueKey": "value",
                  "prefix": "$",
                  "formatNumber": true,
                  "icon": "mdi:receipt-text",
                  "iconColor": "#eab308"
                }
              }
            },
            {
              "id": "md-weekly-revenue-section",
              "type": "MarkdownBlock",
              "name": "DynamicMarkdownBlock",
              "props": {
                "content": "---\n\n## Daily Revenue Breakdown\n\nThe chart below shows daily revenue for the past 7 days, helping identify day-of-week patterns and any anomalies in sales activity."
              }
            },
            {
              "id": "chart-daily-revenue-week",
              "type": "BarChart",
              "name": "DynamicBarChart",
              "props": {
                "query": null,
                "externalTool": {
                  "toolId": "__IKEA_TOOL_ID__",
                  "toolName": "__IKEA_TOOL_NAME__",
                  "parameters": {
                    "sql": "SELECT TO_CHAR(order_date::date, 'Dy DD Mon') as day, SUM(total_amount) as revenue, COUNT(*) as orders FROM orders WHERE order_date >= CURRENT_DATE - INTERVAL '7 days' AND status NOT IN ('Cancelled', 'Failed') GROUP BY order_date::date ORDER BY order_date::date"
                  }
                },
                "title": "Daily Revenue — Last 7 Days",
                "description": "Revenue breakdown by day for the past week",
                "config": {
                  "xAxisKey": "day",
                  "yAxisKey": "revenue",
                  "xAxisLabel": "Day",
                  "yAxisLabel": "Revenue ($)",
                  "height": 400,
                  "orientation": "vertical",
                  "colorPalette": ["#6366f1", "#22c55e", "#eab308", "#8B5CF6"]
                }
              }
            },
            {
              "id": "md-weekly-categories-section",
              "type": "MarkdownBlock",
              "name": "DynamicMarkdownBlock",
              "props": {
                "content": "## Top Categories\n\nCategory performance for the week reveals which product segments are driving sales and helps inform merchandising and inventory decisions."
              }
            },
            {
              "id": "chart-week-top-categories",
              "type": "BarChart",
              "name": "DynamicBarChart",
              "props": {
                "query": null,
                "externalTool": {
                  "toolId": "__IKEA_TOOL_ID__",
                  "toolName": "__IKEA_TOOL_NAME__",
                  "parameters": {
                    "sql": "SELECT c.name as category, SUM(oi.quantity * oi.price_at_purchase) as revenue FROM categories c JOIN products p ON c.category_id = p.category_id JOIN product_variants pv ON p.product_id = pv.product_id JOIN order_items oi ON pv.variant_id = oi.variant_id JOIN orders o ON oi.order_id = o.order_id WHERE o.order_date >= CURRENT_DATE - INTERVAL '7 days' AND o.status NOT IN ('Cancelled', 'Failed') GROUP BY c.name ORDER BY revenue DESC LIMIT 8"
                  }
                },
                "title": "Top Categories This Week",
                "description": "Highest revenue categories in the last 7 days",
                "config": {
                  "xAxisKey": "category",
                  "yAxisKey": "revenue",
                  "xAxisLabel": "Category",
                  "yAxisLabel": "Revenue ($)",
                  "height": 400,
                  "orientation": "horizontal",
                  "colorPalette": ["#22c55e", "#6366f1", "#eab308", "#8B5CF6"]
                }
              }
            },
            {
              "id": "md-weekly-orders-section",
              "type": "MarkdownBlock",
              "name": "DynamicMarkdownBlock",
              "props": {
                "content": "---\n\n## Largest Orders\n\nThe table below lists the highest-value orders placed in the past 7 days, providing visibility into key transactions and customer activity."
              }
            },
            {
              "id": "table-week-large-orders",
              "type": "DataTable",
              "name": "DynamicDataTable",
              "props": {
                "query": null,
                "externalTool": {
                  "toolId": "__IKEA_TOOL_ID__",
                  "toolName": "__IKEA_TOOL_NAME__",
                  "parameters": {
                    "sql": "SELECT o.order_id, o.order_date::date as order_date, c.first_name || ' ' || c.last_name as customer, o.total_amount, o.payment_method, o.delivery_method, o.status FROM orders o JOIN customers c ON o.customer_id = c.customer_id WHERE o.order_date >= CURRENT_DATE - INTERVAL '7 days' AND o.status NOT IN ('Cancelled', 'Failed') ORDER BY o.total_amount DESC LIMIT 20"
                  }
                },
                "title": "Largest Orders This Week",
                "description": "Top 20 highest-value orders from the past 7 days",
                "config": {
                  "pageSize": 10,
                  "showPagination": true,
                  "sortable": true,
                  "striped": true,
                  "hoverable": true,
                  "compact": false
                }
              }
            }
          ]
        }
      }
    }
  }
}$json$::jsonb,
    true
);

-- Report 2: Monthly Revenue & Growth Report
INSERT INTO reports (report_id, project_id, name, description, report, published)
VALUES (
    'ikea-monthly-revenue-growth',
    :project_id,
    'Monthly Revenue & Growth Report',
    'Deep-dive into monthly revenue performance, growth trajectory, and category-level revenue trends',
    $json${
  "dsl": {
    "id": "monthly-revenue-growth",
    "name": "Monthly Revenue & Growth Report",
    "render": {
      "id": "root",
      "type": "MultiComponentContainer",
      "props": {
        "config": {
          "layout": "vertical",
          "components": [
            {
              "id": "md-monthly-header",
              "type": "MarkdownBlock",
              "name": "DynamicMarkdownBlock",
              "props": {
                "content": "# Monthly Revenue & Growth Report\n\n**Prepared by:** Business Intelligence Team\n\n---\n\n## Executive Summary\n\nThis report provides an in-depth analysis of revenue performance across monthly and yearly timeframes. Growth trajectory, order volume trends, and category-level revenue breakdowns are examined to support strategic decision-making.\n\n> **Key Takeaway:** Consistent month-over-month revenue growth combined with healthy order volumes signals strong business fundamentals and effective go-to-market strategies."
              }
            },
            {
              "id": "kpi-monthly-revenue",
              "type": "KPICard",
              "name": "DynamicKPICard",
              "props": {
                "query": null,
                "externalTool": {
                  "toolId": "__IKEA_TOOL_ID__",
                  "toolName": "__IKEA_TOOL_NAME__",
                  "parameters": {
                    "sql": "SELECT SUM(total_amount) as value FROM orders WHERE DATE_TRUNC('month', order_date) = DATE_TRUNC('month', CURRENT_DATE) AND status NOT IN ('Cancelled', 'Failed')"
                  }
                },
                "title": "Current Month Revenue",
                "description": "Total revenue for the current month",
                "config": {
                  "valueKey": "value",
                  "prefix": "$",
                  "formatNumber": true,
                  "icon": "mdi:currency-usd",
                  "iconColor": "#22c55e"
                }
              }
            },
            {
              "id": "kpi-ytd-revenue",
              "type": "KPICard",
              "name": "DynamicKPICard",
              "props": {
                "query": null,
                "externalTool": {
                  "toolId": "__IKEA_TOOL_ID__",
                  "toolName": "__IKEA_TOOL_NAME__",
                  "parameters": {
                    "sql": "SELECT SUM(total_amount) as value FROM orders WHERE DATE_TRUNC('year', order_date) = DATE_TRUNC('year', CURRENT_DATE) AND status NOT IN ('Cancelled', 'Failed')"
                  }
                },
                "title": "Year-to-Date Revenue",
                "description": "Cumulative revenue for the current year",
                "config": {
                  "valueKey": "value",
                  "prefix": "$",
                  "formatNumber": true,
                  "icon": "mdi:chart-timeline-variant",
                  "iconColor": "#6366f1"
                }
              }
            },
            {
              "id": "kpi-avg-daily-revenue",
              "type": "KPICard",
              "name": "DynamicKPICard",
              "props": {
                "query": null,
                "externalTool": {
                  "toolId": "__IKEA_TOOL_ID__",
                  "toolName": "__IKEA_TOOL_NAME__",
                  "parameters": {
                    "sql": "SELECT ROUND(AVG(daily_rev), 2) as value FROM (SELECT order_date::date, SUM(total_amount) as daily_rev FROM orders WHERE order_date >= CURRENT_DATE - INTERVAL '30 days' AND status NOT IN ('Cancelled', 'Failed') GROUP BY order_date::date) sub"
                  }
                },
                "title": "Avg Daily Revenue",
                "description": "Average daily revenue over last 30 days",
                "config": {
                  "valueKey": "value",
                  "prefix": "$",
                  "formatNumber": true,
                  "icon": "mdi:calendar-today",
                  "iconColor": "#8B5CF6"
                }
              }
            },
            {
              "id": "kpi-monthly-orders",
              "type": "KPICard",
              "name": "DynamicKPICard",
              "props": {
                "query": null,
                "externalTool": {
                  "toolId": "__IKEA_TOOL_ID__",
                  "toolName": "__IKEA_TOOL_NAME__",
                  "parameters": {
                    "sql": "SELECT COUNT(*) as value FROM orders WHERE DATE_TRUNC('month', order_date) = DATE_TRUNC('month', CURRENT_DATE) AND status NOT IN ('Cancelled', 'Failed')"
                  }
                },
                "title": "Current Month Orders",
                "description": "Total orders placed this month",
                "config": {
                  "valueKey": "value",
                  "formatNumber": true,
                  "icon": "mdi:cart-check",
                  "iconColor": "#eab308"
                }
              }
            },
            {
              "id": "md-monthly-trend-section",
              "type": "MarkdownBlock",
              "name": "DynamicMarkdownBlock",
              "props": {
                "content": "---\n\n## Revenue Trends\n\nThe charts below illustrate the 12-month revenue trajectory and order volume trends. These long-term views help identify seasonal patterns and sustained growth momentum."
              }
            },
            {
              "id": "chart-monthly-revenue-12m",
              "type": "LineChart",
              "name": "DynamicLineChart",
              "props": {
                "query": null,
                "externalTool": {
                  "toolId": "__IKEA_TOOL_ID__",
                  "toolName": "__IKEA_TOOL_NAME__",
                  "parameters": {
                    "sql": "SELECT TO_CHAR(DATE_TRUNC('month', order_date), 'YYYY-MM') as month, SUM(total_amount) as revenue, COUNT(*) as orders FROM orders WHERE order_date >= CURRENT_DATE - INTERVAL '12 months' AND status NOT IN ('Cancelled', 'Failed') GROUP BY DATE_TRUNC('month', order_date) ORDER BY DATE_TRUNC('month', order_date)"
                  }
                },
                "title": "12-Month Revenue Trend",
                "description": "Monthly revenue trajectory over the last year",
                "config": {
                  "xAxisKey": "month",
                  "yAxisKey": "revenue",
                  "xAxisLabel": "Month",
                  "yAxisLabel": "Revenue ($)",
                  "height": 400,
                  "smooth": true,
                  "showArea": true,
                  "showDataPoints": true,
                  "colorPalette": ["#6366f1", "#22c55e", "#eab308", "#8B5CF6"]
                }
              }
            },
            {
              "id": "md-monthly-orders-trend-section",
              "type": "MarkdownBlock",
              "name": "DynamicMarkdownBlock",
              "props": {
                "content": "## Order Volume & Average Order Value\n\nTracking order count alongside average order value reveals whether revenue growth is driven by more transactions or higher transaction values."
              }
            },
            {
              "id": "chart-monthly-orders-trend",
              "type": "LineChart",
              "name": "DynamicLineChart",
              "props": {
                "query": null,
                "externalTool": {
                  "toolId": "__IKEA_TOOL_ID__",
                  "toolName": "__IKEA_TOOL_NAME__",
                  "parameters": {
                    "sql": "SELECT TO_CHAR(DATE_TRUNC('month', order_date), 'YYYY-MM') as month, COUNT(*) as orders, ROUND(AVG(total_amount), 2) as avg_order_value FROM orders WHERE order_date >= CURRENT_DATE - INTERVAL '12 months' AND status NOT IN ('Cancelled', 'Failed') GROUP BY DATE_TRUNC('month', order_date) ORDER BY DATE_TRUNC('month', order_date)"
                  }
                },
                "title": "Monthly Order Volume & AOV Trend",
                "description": "Order count and average order value over 12 months",
                "config": {
                  "xAxisKey": "month",
                  "yAxisKey": "orders",
                  "xAxisLabel": "Month",
                  "yAxisLabel": "Orders",
                  "height": 400,
                  "smooth": true,
                  "showArea": false,
                  "showDataPoints": true,
                  "colorPalette": ["#22c55e", "#6366f1", "#eab308", "#8B5CF6"]
                }
              }
            },
            {
              "id": "md-monthly-category-section",
              "type": "MarkdownBlock",
              "name": "DynamicMarkdownBlock",
              "props": {
                "content": "---\n\n## Category Revenue Breakdown\n\nThe table below ranks all product categories by total revenue, units sold, and average price — providing a complete view of where revenue is generated."
              }
            },
            {
              "id": "table-monthly-category-revenue",
              "type": "DataTable",
              "name": "DynamicDataTable",
              "props": {
                "query": null,
                "externalTool": {
                  "toolId": "__IKEA_TOOL_ID__",
                  "toolName": "__IKEA_TOOL_NAME__",
                  "parameters": {
                    "sql": "SELECT c.name as category, SUM(oi.quantity * oi.price_at_purchase) as revenue, SUM(oi.quantity) as units_sold, COUNT(DISTINCT o.order_id) as orders, ROUND(AVG(oi.price_at_purchase), 2) as avg_price FROM categories c JOIN products p ON c.category_id = p.category_id JOIN product_variants pv ON p.product_id = pv.product_id JOIN order_items oi ON pv.variant_id = oi.variant_id JOIN orders o ON oi.order_id = o.order_id WHERE o.status NOT IN ('Cancelled', 'Failed') GROUP BY c.name ORDER BY revenue DESC"
                  }
                },
                "title": "Revenue Breakdown by Category",
                "description": "All categories ranked by revenue with units and average price",
                "config": {
                  "pageSize": 10,
                  "showPagination": true,
                  "sortable": true,
                  "striped": true,
                  "hoverable": true,
                  "compact": false
                }
              }
            }
          ]
        }
      }
    }
  }
}$json$::jsonb,
    true
);

-- Report 3: Customer Acquisition & Loyalty Report
INSERT INTO reports (report_id, project_id, name, description, report, published)
VALUES (
    'ikea-customer-loyalty-report',
    :project_id,
    'Customer Acquisition & Loyalty Report',
    'Customer growth trends, loyalty program effectiveness, and high-value customer identification',
    $json${
  "dsl": {
    "id": "customer-loyalty-report",
    "name": "Customer Acquisition & Loyalty Report",
    "render": {
      "id": "root",
      "type": "MultiComponentContainer",
      "props": {
        "config": {
          "layout": "vertical",
          "components": [
            {
              "id": "md-customer-header",
              "type": "MarkdownBlock",
              "name": "DynamicMarkdownBlock",
              "props": {
                "content": "# Customer Acquisition & Loyalty Report\n\n**Prepared by:** Customer Analytics Team\n\n---\n\n## Executive Summary\n\nThis report analyzes customer acquisition trends, loyalty program performance, and high-value customer segments. Understanding customer lifetime value and retention patterns is essential for optimizing marketing spend and building long-term customer relationships.\n\n> **Key Takeaway:** Loyalty program members consistently demonstrate higher lifetime value, reinforcing the importance of enrollment and engagement initiatives."
              }
            },
            {
              "id": "kpi-total-customers-rpt",
              "type": "KPICard",
              "name": "DynamicKPICard",
              "props": {
                "query": null,
                "externalTool": {
                  "toolId": "__IKEA_TOOL_ID__",
                  "toolName": "__IKEA_TOOL_NAME__",
                  "parameters": {
                    "sql": "SELECT COUNT(*) as value FROM customers"
                  }
                },
                "title": "Total Customers",
                "description": "All registered customers",
                "config": {
                  "valueKey": "value",
                  "formatNumber": true,
                  "icon": "mdi:account-group",
                  "iconColor": "#6366f1"
                }
              }
            },
            {
              "id": "kpi-loyalty-members-rpt",
              "type": "KPICard",
              "name": "DynamicKPICard",
              "props": {
                "query": null,
                "externalTool": {
                  "toolId": "__IKEA_TOOL_ID__",
                  "toolName": "__IKEA_TOOL_NAME__",
                  "parameters": {
                    "sql": "SELECT COUNT(*) as value FROM customers WHERE is_loyalty_member = true"
                  }
                },
                "title": "Loyalty Members",
                "description": "Customers enrolled in loyalty program",
                "config": {
                  "valueKey": "value",
                  "formatNumber": true,
                  "icon": "mdi:heart",
                  "iconColor": "#ef4444"
                }
              }
            },
            {
              "id": "kpi-repeat-buyers-rpt",
              "type": "KPICard",
              "name": "DynamicKPICard",
              "props": {
                "query": null,
                "externalTool": {
                  "toolId": "__IKEA_TOOL_ID__",
                  "toolName": "__IKEA_TOOL_NAME__",
                  "parameters": {
                    "sql": "SELECT COUNT(*) as value FROM (SELECT customer_id FROM orders WHERE status NOT IN ('Cancelled', 'Failed') GROUP BY customer_id HAVING COUNT(*) > 1) sub"
                  }
                },
                "title": "Repeat Buyers",
                "description": "Customers with more than one order",
                "config": {
                  "valueKey": "value",
                  "formatNumber": true,
                  "icon": "mdi:account-arrow-right",
                  "iconColor": "#22c55e"
                }
              }
            },
            {
              "id": "kpi-avg-clv-rpt",
              "type": "KPICard",
              "name": "DynamicKPICard",
              "props": {
                "query": null,
                "externalTool": {
                  "toolId": "__IKEA_TOOL_ID__",
                  "toolName": "__IKEA_TOOL_NAME__",
                  "parameters": {
                    "sql": "SELECT ROUND(AVG(total_spend), 2) as value FROM (SELECT customer_id, SUM(total_amount) as total_spend FROM orders WHERE status NOT IN ('Cancelled', 'Failed') GROUP BY customer_id) sub"
                  }
                },
                "title": "Avg Customer Value",
                "description": "Average lifetime spend per customer",
                "config": {
                  "valueKey": "value",
                  "prefix": "$",
                  "formatNumber": true,
                  "icon": "mdi:account-cash",
                  "iconColor": "#eab308"
                }
              }
            },
            {
              "id": "md-customer-growth-section",
              "type": "MarkdownBlock",
              "name": "DynamicMarkdownBlock",
              "props": {
                "content": "---\n\n## Customer Growth\n\nThe chart below tracks monthly customer registrations over time, showing the trajectory of customer acquisition and identifying periods of accelerated growth."
              }
            },
            {
              "id": "chart-customer-growth",
              "type": "LineChart",
              "name": "DynamicLineChart",
              "props": {
                "query": null,
                "externalTool": {
                  "toolId": "__IKEA_TOOL_ID__",
                  "toolName": "__IKEA_TOOL_NAME__",
                  "parameters": {
                    "sql": "SELECT TO_CHAR(DATE_TRUNC('month', created_at), 'YYYY-MM') as month, COUNT(*) as new_customers, SUM(COUNT(*)) OVER (ORDER BY DATE_TRUNC('month', created_at)) as cumulative_customers FROM customers GROUP BY DATE_TRUNC('month', created_at) ORDER BY DATE_TRUNC('month', created_at)"
                  }
                },
                "title": "Customer Growth Over Time",
                "description": "Monthly new customer registrations",
                "config": {
                  "xAxisKey": "month",
                  "yAxisKey": "new_customers",
                  "xAxisLabel": "Month",
                  "yAxisLabel": "New Customers",
                  "height": 400,
                  "smooth": true,
                  "showArea": true,
                  "showDataPoints": true,
                  "colorPalette": ["#6366f1", "#22c55e", "#eab308", "#8B5CF6"]
                }
              }
            },
            {
              "id": "md-customer-loyalty-section",
              "type": "MarkdownBlock",
              "name": "DynamicMarkdownBlock",
              "props": {
                "content": "## Loyalty Program Impact\n\nComparing average lifetime value between loyalty members and non-members demonstrates the ROI of the loyalty program and helps justify continued investment in member engagement."
              }
            },
            {
              "id": "chart-loyalty-spend-comparison",
              "type": "BarChart",
              "name": "DynamicBarChart",
              "props": {
                "query": null,
                "externalTool": {
                  "toolId": "__IKEA_TOOL_ID__",
                  "toolName": "__IKEA_TOOL_NAME__",
                  "parameters": {
                    "sql": "SELECT CASE WHEN c.is_loyalty_member THEN 'Loyalty Members' ELSE 'Non-Members' END as segment, ROUND(AVG(sub.total_spend), 2) as avg_lifetime_value, ROUND(AVG(sub.order_count), 1) as avg_orders FROM customers c JOIN (SELECT customer_id, SUM(total_amount) as total_spend, COUNT(*) as order_count FROM orders WHERE status NOT IN ('Cancelled', 'Failed') GROUP BY customer_id) sub ON c.customer_id = sub.customer_id GROUP BY c.is_loyalty_member"
                  }
                },
                "title": "Loyalty vs Non-Loyalty — Avg Lifetime Value",
                "description": "Comparing average spend between loyalty members and non-members",
                "config": {
                  "xAxisKey": "segment",
                  "yAxisKey": "avg_lifetime_value",
                  "xAxisLabel": "Segment",
                  "yAxisLabel": "Avg Lifetime Value ($)",
                  "height": 400,
                  "orientation": "vertical",
                  "colorPalette": ["#6366f1", "#e2e8f0"]
                }
              }
            },
            {
              "id": "md-customer-highvalue-section",
              "type": "MarkdownBlock",
              "name": "DynamicMarkdownBlock",
              "props": {
                "content": "---\n\n## High-Value Customers\n\nThe table below identifies the top 25 highest-spending customers, including their loyalty status, order frequency, and most recent purchase date. These customers represent the core of the business and warrant personalized engagement strategies."
              }
            },
            {
              "id": "table-high-value-customers-rpt",
              "type": "DataTable",
              "name": "DynamicDataTable",
              "props": {
                "query": null,
                "externalTool": {
                  "toolId": "__IKEA_TOOL_ID__",
                  "toolName": "__IKEA_TOOL_NAME__",
                  "parameters": {
                    "sql": "SELECT c.first_name || ' ' || c.last_name as customer, c.email, CASE WHEN c.is_loyalty_member THEN 'Yes' ELSE 'No' END as loyalty, COUNT(o.order_id) as orders, SUM(o.total_amount) as total_spend, MAX(o.order_date)::date as last_order FROM customers c JOIN orders o ON c.customer_id = o.customer_id WHERE o.status NOT IN ('Cancelled', 'Failed') GROUP BY c.customer_id, c.first_name, c.last_name, c.email, c.is_loyalty_member ORDER BY total_spend DESC LIMIT 25"
                  }
                },
                "title": "Top 25 Highest-Value Customers",
                "description": "Customers ranked by total lifetime spend",
                "config": {
                  "pageSize": 10,
                  "showPagination": true,
                  "sortable": true,
                  "striped": true,
                  "hoverable": true,
                  "compact": false
                }
              }
            }
          ]
        }
      }
    }
  }
}$json$::jsonb,
    true
);

-- Report 4: Inventory Risk Report
INSERT INTO reports (report_id, project_id, name, description, report, published)
VALUES (
    'ikea-inventory-risk-report',
    :project_id,
    'Inventory Risk Report',
    'Stock coverage analysis across locations — identifies low-stock, out-of-stock, and overstocked items',
    $json${
  "dsl": {
    "id": "inventory-risk-report",
    "name": "Inventory Risk Report",
    "render": {
      "id": "root",
      "type": "MultiComponentContainer",
      "props": {
        "config": {
          "layout": "vertical",
          "components": [
            {
              "id": "md-inventory-header",
              "type": "MarkdownBlock",
              "name": "DynamicMarkdownBlock",
              "props": {
                "content": "# Inventory Risk Report\n\n**Prepared by:** Supply Chain & Inventory Team\n\n---\n\n## Executive Summary\n\nThis report assesses inventory health across all store locations. It identifies low-stock and out-of-stock situations, monitors total inventory levels, and provides a category-level view of stock distribution to support replenishment planning.\n\n> **Key Takeaway:** Proactive inventory monitoring prevents lost sales from stockouts and reduces carrying costs from overstocking. Items flagged as critical require immediate replenishment action."
              }
            },
            {
              "id": "kpi-total-sku-locations",
              "type": "KPICard",
              "name": "DynamicKPICard",
              "props": {
                "query": null,
                "externalTool": {
                  "toolId": "__IKEA_TOOL_ID__",
                  "toolName": "__IKEA_TOOL_NAME__",
                  "parameters": {
                    "sql": "SELECT COUNT(*) as value FROM inventory"
                  }
                },
                "title": "Total SKU-Locations",
                "description": "Product-location inventory records tracked",
                "config": {
                  "valueKey": "value",
                  "formatNumber": true,
                  "icon": "mdi:warehouse",
                  "iconColor": "#6366f1"
                }
              }
            },
            {
              "id": "kpi-low-stock-items",
              "type": "KPICard",
              "name": "DynamicKPICard",
              "props": {
                "query": null,
                "externalTool": {
                  "toolId": "__IKEA_TOOL_ID__",
                  "toolName": "__IKEA_TOOL_NAME__",
                  "parameters": {
                    "sql": "SELECT COUNT(*) as value FROM inventory WHERE quantity_available < 10 AND quantity_available > 0"
                  }
                },
                "title": "Low Stock Items",
                "description": "SKU-locations with fewer than 10 units remaining",
                "config": {
                  "valueKey": "value",
                  "formatNumber": true,
                  "icon": "mdi:alert-outline",
                  "iconColor": "#eab308"
                }
              }
            },
            {
              "id": "kpi-out-of-stock",
              "type": "KPICard",
              "name": "DynamicKPICard",
              "props": {
                "query": null,
                "externalTool": {
                  "toolId": "__IKEA_TOOL_ID__",
                  "toolName": "__IKEA_TOOL_NAME__",
                  "parameters": {
                    "sql": "SELECT COUNT(*) as value FROM inventory WHERE quantity_available = 0"
                  }
                },
                "title": "Out of Stock",
                "description": "SKU-locations with zero inventory",
                "config": {
                  "valueKey": "value",
                  "formatNumber": true,
                  "icon": "mdi:package-variant-remove",
                  "iconColor": "#ef4444"
                }
              }
            },
            {
              "id": "kpi-total-units",
              "type": "KPICard",
              "name": "DynamicKPICard",
              "props": {
                "query": null,
                "externalTool": {
                  "toolId": "__IKEA_TOOL_ID__",
                  "toolName": "__IKEA_TOOL_NAME__",
                  "parameters": {
                    "sql": "SELECT SUM(quantity_available) as value FROM inventory"
                  }
                },
                "title": "Total Units in Stock",
                "description": "Total inventory units across all locations",
                "config": {
                  "valueKey": "value",
                  "formatNumber": true,
                  "icon": "mdi:package-variant-closed",
                  "iconColor": "#22c55e"
                }
              }
            },
            {
              "id": "md-inventory-location-section",
              "type": "MarkdownBlock",
              "name": "DynamicMarkdownBlock",
              "props": {
                "content": "---\n\n## Inventory by Location\n\nThe chart below shows total stock levels per store location. Locations with disproportionately low inventory may require priority replenishment to avoid stockouts."
              }
            },
            {
              "id": "chart-inventory-by-location",
              "type": "BarChart",
              "name": "DynamicBarChart",
              "props": {
                "query": null,
                "externalTool": {
                  "toolId": "__IKEA_TOOL_ID__",
                  "toolName": "__IKEA_TOOL_NAME__",
                  "parameters": {
                    "sql": "SELECT l.location_name as location, SUM(i.quantity_available) as total_stock, COUNT(CASE WHEN i.quantity_available = 0 THEN 1 END) as out_of_stock_skus FROM locations l JOIN inventory i ON l.location_id = i.location_id GROUP BY l.location_id, l.location_name ORDER BY total_stock DESC LIMIT 15"
                  }
                },
                "title": "Inventory by Store Location",
                "description": "Total units in stock per location",
                "config": {
                  "xAxisKey": "location",
                  "yAxisKey": "total_stock",
                  "xAxisLabel": "Location",
                  "yAxisLabel": "Units",
                  "height": 400,
                  "orientation": "horizontal",
                  "colorPalette": ["#6366f1", "#22c55e", "#eab308", "#8B5CF6"]
                }
              }
            },
            {
              "id": "md-inventory-category-section",
              "type": "MarkdownBlock",
              "name": "DynamicMarkdownBlock",
              "props": {
                "content": "## Stock Distribution by Category\n\nUnderstanding how inventory is distributed across product categories helps identify imbalances and informs purchasing decisions."
              }
            },
            {
              "id": "chart-stock-by-category",
              "type": "PieChart",
              "name": "DynamicPieChart",
              "props": {
                "query": null,
                "externalTool": {
                  "toolId": "__IKEA_TOOL_ID__",
                  "toolName": "__IKEA_TOOL_NAME__",
                  "parameters": {
                    "sql": "SELECT c.name as category, SUM(i.quantity_available) as stock FROM categories c JOIN products p ON c.category_id = p.category_id JOIN product_variants pv ON p.product_id = pv.product_id JOIN inventory i ON pv.variant_id = i.variant_id GROUP BY c.name ORDER BY stock DESC LIMIT 8"
                  }
                },
                "title": "Stock Distribution by Category",
                "description": "How inventory is distributed across product categories",
                "config": {
                  "nameKey": "category",
                  "valueKey": "stock",
                  "height": 400,
                  "showPercentage": true,
                  "donut": true,
                  "donutRadius": ["40%", "70%"],
                  "colorPalette": ["#6366f1", "#22c55e", "#eab308", "#ef4444", "#8B5CF6", "#06b6d4", "#f97316", "#a855f7"]
                }
              }
            },
            {
              "id": "md-inventory-critical-section",
              "type": "MarkdownBlock",
              "name": "DynamicMarkdownBlock",
              "props": {
                "content": "---\n\n## Critical Stock Items\n\nThe table below lists products with fewer than 10 units remaining at their respective locations. Items marked as **CRITICAL** or **OUT OF STOCK** require immediate attention from the replenishment team."
              }
            },
            {
              "id": "table-critical-stock",
              "type": "DataTable",
              "name": "DynamicDataTable",
              "props": {
                "query": null,
                "externalTool": {
                  "toolId": "__IKEA_TOOL_ID__",
                  "toolName": "__IKEA_TOOL_NAME__",
                  "parameters": {
                    "sql": "SELECT p.name as product, pv.color as variant, l.location_name as location, i.quantity_available as stock, CASE WHEN i.quantity_available = 0 THEN 'OUT OF STOCK' WHEN i.quantity_available < 5 THEN 'CRITICAL' WHEN i.quantity_available < 10 THEN 'LOW' ELSE 'OK' END as status FROM inventory i JOIN product_variants pv ON i.variant_id = pv.variant_id JOIN products p ON pv.product_id = p.product_id JOIN locations l ON i.location_id = l.location_id WHERE i.quantity_available < 10 ORDER BY i.quantity_available ASC, p.name LIMIT 30"
                  }
                },
                "title": "Critical Stock Items",
                "description": "Products with fewer than 10 units — requires immediate attention",
                "config": {
                  "pageSize": 10,
                  "showPagination": true,
                  "sortable": true,
                  "striped": true,
                  "hoverable": true,
                  "compact": false
                }
              }
            }
          ]
        }
      }
    }
  }
}$json$::jsonb,
    true
);

-- Report 5: Order Fulfillment Quality Report
INSERT INTO reports (report_id, project_id, name, description, report, published)
VALUES (
    'ikea-fulfillment-quality-report',
    :project_id,
    'Order Fulfillment & Quality Report',
    'Delivery performance, cancellation analysis, and customer satisfaction metrics',
    $json${
  "dsl": {
    "id": "fulfillment-quality-report",
    "name": "Order Fulfillment & Quality Report",
    "render": {
      "id": "root",
      "type": "MultiComponentContainer",
      "props": {
        "config": {
          "layout": "vertical",
          "components": [
            {
              "id": "md-fulfillment-header",
              "type": "MarkdownBlock",
              "name": "DynamicMarkdownBlock",
              "props": {
                "content": "# Order Fulfillment & Quality Report\n\n**Prepared by:** Operations & Customer Experience Team\n\n---\n\n## Executive Summary\n\nThis report evaluates order fulfillment performance, cancellation trends, and customer satisfaction levels. Maintaining high fulfillment rates and understanding cancellation drivers are critical to delivering excellent customer experiences and reducing operational losses.\n\n> **Key Takeaway:** A high fulfillment rate combined with low cancellation rates indicates strong operational execution. Analyzing cancellation reasons helps target specific process improvements."
              }
            },
            {
              "id": "kpi-fulfillment-rate-rpt",
              "type": "KPICard",
              "name": "DynamicKPICard",
              "props": {
                "query": null,
                "externalTool": {
                  "toolId": "__IKEA_TOOL_ID__",
                  "toolName": "__IKEA_TOOL_NAME__",
                  "parameters": {
                    "sql": "SELECT ROUND(100.0 * COUNT(*) FILTER (WHERE status = 'Delivered') / COUNT(*), 1) as value FROM orders"
                  }
                },
                "title": "Fulfillment Rate",
                "description": "Percentage of all orders successfully delivered",
                "config": {
                  "valueKey": "value",
                  "suffix": "%",
                  "formatNumber": true,
                  "icon": "mdi:check-circle",
                  "iconColor": "#22c55e"
                }
              }
            },
            {
              "id": "kpi-cancel-rate-rpt",
              "type": "KPICard",
              "name": "DynamicKPICard",
              "props": {
                "query": null,
                "externalTool": {
                  "toolId": "__IKEA_TOOL_ID__",
                  "toolName": "__IKEA_TOOL_NAME__",
                  "parameters": {
                    "sql": "SELECT ROUND(100.0 * COUNT(*) FILTER (WHERE status = 'Cancelled') / COUNT(*), 1) as value FROM orders"
                  }
                },
                "title": "Cancellation Rate",
                "description": "Percentage of orders cancelled",
                "config": {
                  "valueKey": "value",
                  "suffix": "%",
                  "formatNumber": true,
                  "icon": "mdi:close-circle",
                  "iconColor": "#ef4444"
                }
              }
            },
            {
              "id": "kpi-avg-rating-rpt",
              "type": "KPICard",
              "name": "DynamicKPICard",
              "props": {
                "query": null,
                "externalTool": {
                  "toolId": "__IKEA_TOOL_ID__",
                  "toolName": "__IKEA_TOOL_NAME__",
                  "parameters": {
                    "sql": "SELECT ROUND(AVG(rating), 2) as value FROM reviews"
                  }
                },
                "title": "Customer Satisfaction",
                "description": "Average product review rating",
                "config": {
                  "valueKey": "value",
                  "suffix": " / 5",
                  "formatNumber": true,
                  "icon": "mdi:star",
                  "iconColor": "#eab308"
                }
              }
            },
            {
              "id": "kpi-pending-orders-rpt",
              "type": "KPICard",
              "name": "DynamicKPICard",
              "props": {
                "query": null,
                "externalTool": {
                  "toolId": "__IKEA_TOOL_ID__",
                  "toolName": "__IKEA_TOOL_NAME__",
                  "parameters": {
                    "sql": "SELECT COUNT(*) as value FROM orders WHERE status IN ('Pending', 'Processing', 'Shipped')"
                  }
                },
                "title": "Orders In Pipeline",
                "description": "Orders pending, processing, or in transit",
                "config": {
                  "valueKey": "value",
                  "formatNumber": true,
                  "icon": "mdi:clock-outline",
                  "iconColor": "#8B5CF6"
                }
              }
            },
            {
              "id": "md-fulfillment-status-section",
              "type": "MarkdownBlock",
              "name": "DynamicMarkdownBlock",
              "props": {
                "content": "---\n\n## Order Status Overview\n\nThe distribution of orders across fulfillment statuses provides a real-time snapshot of operational health. A high proportion of delivered orders relative to cancelled or failed orders indicates strong execution."
              }
            },
            {
              "id": "chart-order-status-dist",
              "type": "PieChart",
              "name": "DynamicPieChart",
              "props": {
                "query": null,
                "externalTool": {
                  "toolId": "__IKEA_TOOL_ID__",
                  "toolName": "__IKEA_TOOL_NAME__",
                  "parameters": {
                    "sql": "SELECT status, COUNT(*) as order_count FROM orders GROUP BY status ORDER BY order_count DESC"
                  }
                },
                "title": "Order Status Distribution",
                "description": "Breakdown of all orders by current fulfillment status",
                "config": {
                  "nameKey": "status",
                  "valueKey": "order_count",
                  "height": 400,
                  "showPercentage": true,
                  "donut": true,
                  "donutRadius": ["40%", "70%"],
                  "colorPalette": ["#22c55e", "#6366f1", "#8B5CF6", "#eab308", "#ef4444", "#94a3b8"]
                }
              }
            },
            {
              "id": "md-fulfillment-cancellation-section",
              "type": "MarkdownBlock",
              "name": "DynamicMarkdownBlock",
              "props": {
                "content": "## Cancellation Analysis\n\nIdentifying the most common reasons for order cancellations enables targeted process improvements and helps reduce cancellation rates over time."
              }
            },
            {
              "id": "chart-cancellation-reasons",
              "type": "BarChart",
              "name": "DynamicBarChart",
              "props": {
                "query": null,
                "externalTool": {
                  "toolId": "__IKEA_TOOL_ID__",
                  "toolName": "__IKEA_TOOL_NAME__",
                  "parameters": {
                    "sql": "SELECT COALESCE(cancellation_reason, 'Not specified') as reason, COUNT(*) as count FROM orders WHERE status = 'Cancelled' AND cancellation_reason IS NOT NULL GROUP BY cancellation_reason ORDER BY count DESC LIMIT 10"
                  }
                },
                "title": "Top Cancellation Reasons",
                "description": "Most common reasons customers cancel orders",
                "config": {
                  "xAxisKey": "reason",
                  "yAxisKey": "count",
                  "xAxisLabel": "Reason",
                  "yAxisLabel": "Cancelled Orders",
                  "height": 400,
                  "orientation": "horizontal",
                  "colorPalette": ["#ef4444", "#f97316", "#eab308", "#8B5CF6"]
                }
              }
            },
            {
              "id": "md-fulfillment-trend-section",
              "type": "MarkdownBlock",
              "name": "DynamicMarkdownBlock",
              "props": {
                "content": "## Fulfillment Rate Trend\n\nTracking the monthly fulfillment rate over time reveals whether operational improvements are translating into better delivery performance."
              }
            },
            {
              "id": "chart-monthly-fulfillment",
              "type": "LineChart",
              "name": "DynamicLineChart",
              "props": {
                "query": null,
                "externalTool": {
                  "toolId": "__IKEA_TOOL_ID__",
                  "toolName": "__IKEA_TOOL_NAME__",
                  "parameters": {
                    "sql": "SELECT TO_CHAR(DATE_TRUNC('month', order_date), 'YYYY-MM') as month, ROUND(100.0 * COUNT(*) FILTER (WHERE status = 'Delivered') / COUNT(*), 1) as fulfillment_rate FROM orders GROUP BY DATE_TRUNC('month', order_date) ORDER BY DATE_TRUNC('month', order_date)"
                  }
                },
                "title": "Monthly Fulfillment Rate Trend",
                "description": "Fulfillment rate trajectory over time",
                "config": {
                  "xAxisKey": "month",
                  "yAxisKey": "fulfillment_rate",
                  "xAxisLabel": "Month",
                  "yAxisLabel": "Fulfillment Rate (%)",
                  "height": 400,
                  "smooth": true,
                  "showArea": false,
                  "showDataPoints": true,
                  "colorPalette": ["#22c55e", "#6366f1", "#eab308", "#8B5CF6"]
                }
              }
            },
            {
              "id": "md-fulfillment-failures-section",
              "type": "MarkdownBlock",
              "name": "DynamicMarkdownBlock",
              "props": {
                "content": "---\n\n## Recent Cancellations & Failures\n\nThe table below lists the most recent cancelled and failed orders with their reasons. This data supports root cause analysis and helps identify systemic issues requiring corrective action."
              }
            },
            {
              "id": "table-recent-cancellations",
              "type": "DataTable",
              "name": "DynamicDataTable",
              "props": {
                "query": null,
                "externalTool": {
                  "toolId": "__IKEA_TOOL_ID__",
                  "toolName": "__IKEA_TOOL_NAME__",
                  "parameters": {
                    "sql": "SELECT o.order_id, o.order_date::date as order_date, c.first_name || ' ' || c.last_name as customer, o.total_amount, o.status, COALESCE(o.cancellation_reason, o.failure_reason, 'N/A') as reason FROM orders o JOIN customers c ON o.customer_id = c.customer_id WHERE o.status IN ('Cancelled', 'Failed') ORDER BY o.order_date DESC LIMIT 20"
                  }
                },
                "title": "Recent Cancelled & Failed Orders",
                "description": "Most recent order cancellations and failures with reasons",
                "config": {
                  "pageSize": 10,
                  "showPagination": true,
                  "sortable": true,
                  "striped": true,
                  "hoverable": true,
                  "compact": false
                }
              }
            }
          ]
        }
      }
    }
  }
}$json$::jsonb,
    true
);
