-- =============================================================================
-- Default Dashboards for IKEA Dataset
-- Seeded during setup for CIO/CTO demo experience
-- Uses :project_id psql variable for project association
-- Tool ID placeholders (__IKEA_TOOL_ID__, __IKEA_TOOL_NAME__) are replaced
-- by setup.sh via sed before execution, since psql variables don't work inside $json$
-- Format: Pages-based GridStack widget DSL (matches sa-platform-ui)
-- =============================================================================

-- Clean up existing default dashboards for this project (idempotent)
DELETE FROM dashboards WHERE dashboard_id IN (
    'ikea-business-overview',
    'ikea-customer-intelligence',
    'ikea-channel-operations',
    'ikea-product-portfolio',
    'ikea-store-performance',
    'ikea-order-explorer'
) AND project_id = :project_id;

-- Dashboard 1: Business Performance Overview
INSERT INTO dashboards (dashboard_id, project_id, name, description, dashboard, published, allowed_users)
VALUES (
    'ikea-business-overview',
    :project_id,
    'Business Performance Overview',
    'Executive snapshot of overall business health - revenue, orders, and category performance',
    $json${
  "dsl": {
    "id": "dashboard-ikea-business-overview",
    "name": "Business Performance Overview",
    "defaultPageId": "page-main",
    "pages": [{
      "id": "page-main",
      "name": "Main",
      "order": 0,
      "render": {
        "id": "render-page-main",
        "type": "GRID_DASHBOARD",
        "props": {
          "backgroundColor": "#ffffff",
          "columns": 24,
          "cellHeight": 20,
          "margin": 10,
          "widgets": [
            {
              "id": "widget-kpi-total-revenue",
              "dsl": {
                "id": "kpi-total-revenue",
                "name": "DynamicKPICard",
                "type": "KPICard",
                "description": "Gross revenue from all completed orders",
                "render": {
                  "id": "render-kpi-total-revenue",
                  "type": "COMP_DYNAMICKPICARD",
                  "props": {
                    "query": null,
                    "externalTool": {
                      "toolId": "__IKEA_TOOL_ID__",
                      "toolName": "__IKEA_TOOL_NAME__",
                      "parameters": {
                        "sql": "SELECT SUM(total_amount) as value FROM orders WHERE status NOT IN ('Cancelled', 'Failed')"
                      }
                    },
                    "title": "Total Revenue",
                    "description": "Gross revenue from all completed orders",
                    "config": {
                      "valueKey": "value",
                      "prefix": "$",
                      "suffix": "",
                      "formatNumber": true,
                      "icon": "mdi:currency-usd",
                      "iconColor": "#22c55e"
                    },
                    "gridstack": {"x": 0, "y": 0, "w": 6, "h": 9},
                    "className": "w-[25.00%] h-[260px]",
                    "SA_RUNTIME": {"uiBlockId": "page-main"}
                  }
                }
              }
            },
            {
              "id": "widget-kpi-total-orders",
              "dsl": {
                "id": "kpi-total-orders",
                "name": "DynamicKPICard",
                "type": "KPICard",
                "description": "Successfully processed orders",
                "render": {
                  "id": "render-kpi-total-orders",
                  "type": "COMP_DYNAMICKPICARD",
                  "props": {
                    "query": null,
                    "externalTool": {
                      "toolId": "__IKEA_TOOL_ID__",
                      "toolName": "__IKEA_TOOL_NAME__",
                      "parameters": {
                        "sql": "SELECT COUNT(*) as value FROM orders WHERE status NOT IN ('Cancelled', 'Failed')"
                      }
                    },
                    "title": "Total Orders",
                    "description": "Successfully processed orders",
                    "config": {
                      "valueKey": "value",
                      "formatNumber": true,
                      "icon": "mdi:cart-outline",
                      "iconColor": "#6366f1"
                    },
                    "gridstack": {"x": 6, "y": 0, "w": 6, "h": 9},
                    "className": "w-[25.00%] h-[260px]",
                    "SA_RUNTIME": {"uiBlockId": "page-main"}
                  }
                }
              }
            },
            {
              "id": "widget-kpi-avg-order-value",
              "dsl": {
                "id": "kpi-avg-order-value",
                "name": "DynamicKPICard",
                "type": "KPICard",
                "description": "Average revenue per order",
                "render": {
                  "id": "render-kpi-avg-order-value",
                  "type": "COMP_DYNAMICKPICARD",
                  "props": {
                    "query": null,
                    "externalTool": {
                      "toolId": "__IKEA_TOOL_ID__",
                      "toolName": "__IKEA_TOOL_NAME__",
                      "parameters": {
                        "sql": "SELECT ROUND(AVG(total_amount), 2) as value FROM orders WHERE status NOT IN ('Cancelled', 'Failed')"
                      }
                    },
                    "title": "Avg Order Value",
                    "description": "Average revenue per order",
                    "config": {
                      "valueKey": "value",
                      "prefix": "$",
                      "formatNumber": true,
                      "icon": "mdi:receipt-text",
                      "iconColor": "#8B5CF6"
                    },
                    "gridstack": {"x": 12, "y": 0, "w": 6, "h": 9},
                    "className": "w-[25.00%] h-[260px]",
                    "SA_RUNTIME": {"uiBlockId": "page-main"}
                  }
                }
              }
            },
            {
              "id": "widget-kpi-fulfillment-rate",
              "dsl": {
                "id": "kpi-fulfillment-rate",
                "name": "DynamicKPICard",
                "type": "KPICard",
                "description": "Percentage of orders successfully delivered",
                "render": {
                  "id": "render-kpi-fulfillment-rate",
                  "type": "COMP_DYNAMICKPICARD",
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
                    "description": "Percentage of orders successfully delivered",
                    "config": {
                      "valueKey": "value",
                      "suffix": "%",
                      "formatNumber": true,
                      "icon": "mdi:check-circle",
                      "iconColor": "#22c55e"
                    },
                    "gridstack": {"x": 18, "y": 0, "w": 6, "h": 9},
                    "className": "w-[25.00%] h-[260px]",
                    "SA_RUNTIME": {"uiBlockId": "page-main"}
                  }
                }
              }
            },
            {
              "id": "widget-chart-monthly-revenue",
              "dsl": {
                "id": "chart-monthly-revenue",
                "name": "DynamicLineChart",
                "type": "LineChart",
                "description": "Revenue trajectory over time",
                "render": {
                  "id": "render-chart-monthly-revenue",
                  "type": "COMP_DYNAMICLINECHART",
                  "props": {
                    "query": null,
                    "externalTool": {
                      "toolId": "__IKEA_TOOL_ID__",
                      "toolName": "__IKEA_TOOL_NAME__",
                      "parameters": {
                        "sql": "SELECT TO_CHAR(DATE_TRUNC('month', order_date), 'YYYY-MM') as month, SUM(total_amount) as revenue FROM orders WHERE status NOT IN ('Cancelled', 'Failed') GROUP BY DATE_TRUNC('month', order_date) ORDER BY DATE_TRUNC('month', order_date)"
                      }
                    },
                    "title": "Monthly Revenue Trend",
                    "description": "Revenue trajectory over time",
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
                    },
                    "gridstack": {"x": 0, "y": 9, "w": 12, "h": 28},
                    "className": "w-[50.00%] h-[830px]",
                    "SA_RUNTIME": {"uiBlockId": "page-main"}
                  }
                }
              }
            },
            {
              "id": "widget-chart-revenue-by-category",
              "dsl": {
                "id": "chart-revenue-by-category",
                "name": "DynamicBarChart",
                "type": "BarChart",
                "description": "Top 10 revenue-generating product categories",
                "render": {
                  "id": "render-chart-revenue-by-category",
                  "type": "COMP_DYNAMICBARCHART",
                  "props": {
                    "query": null,
                    "externalTool": {
                      "toolId": "__IKEA_TOOL_ID__",
                      "toolName": "__IKEA_TOOL_NAME__",
                      "parameters": {
                        "sql": "SELECT c.name as category, SUM(oi.quantity * oi.price_at_purchase) as revenue FROM categories c JOIN products p ON c.category_id = p.category_id JOIN product_variants pv ON p.product_id = pv.product_id JOIN order_items oi ON pv.variant_id = oi.variant_id JOIN orders o ON oi.order_id = o.order_id WHERE o.status NOT IN ('Cancelled', 'Failed') GROUP BY c.name ORDER BY revenue DESC LIMIT 10"
                      }
                    },
                    "title": "Revenue by Product Category",
                    "description": "Top 10 revenue-generating product categories",
                    "config": {
                      "xAxisKey": "category",
                      "yAxisKey": "revenue",
                      "xAxisLabel": "Category",
                      "yAxisLabel": "Revenue ($)",
                      "height": 400,
                      "orientation": "horizontal",
                      "colorPalette": ["#6366f1", "#22c55e", "#eab308", "#8B5CF6"]
                    },
                    "gridstack": {"x": 12, "y": 9, "w": 12, "h": 28},
                    "className": "w-[50.00%] h-[830px]",
                    "SA_RUNTIME": {"uiBlockId": "page-main"}
                  }
                }
              }
            }
          ]
        }
      }
    }]
  }
}$json$::jsonb,
    true,
    '[]'::jsonb
);

-- Dashboard 2: Customer & Loyalty Intelligence
INSERT INTO dashboards (dashboard_id, project_id, name, description, dashboard, published, allowed_users)
VALUES (
    'ikea-customer-intelligence',
    :project_id,
    'Customer & Loyalty Intelligence',
    'Customer acquisition, loyalty program impact, and customer lifetime value analysis',
    $json${
  "dsl": {
    "id": "dashboard-ikea-customer-intelligence",
    "name": "Customer & Loyalty Intelligence",
    "defaultPageId": "page-main",
    "pages": [{
      "id": "page-main",
      "name": "Main",
      "order": 0,
      "render": {
        "id": "render-page-main",
        "type": "GRID_DASHBOARD",
        "props": {
          "backgroundColor": "#ffffff",
          "columns": 24,
          "cellHeight": 20,
          "margin": 10,
          "widgets": [
            {
              "id": "widget-kpi-total-customers",
              "dsl": {
                "id": "kpi-total-customers",
                "name": "DynamicKPICard",
                "type": "KPICard",
                "description": "Customers with at least one completed order",
                "render": {
                  "id": "render-kpi-total-customers",
                  "type": "COMP_DYNAMICKPICARD",
                  "props": {
                    "query": null,
                    "externalTool": {
                      "toolId": "__IKEA_TOOL_ID__",
                      "toolName": "__IKEA_TOOL_NAME__",
                      "parameters": {
                        "sql": "SELECT COUNT(DISTINCT customer_id) as value FROM orders WHERE status NOT IN ('Cancelled', 'Failed')"
                      }
                    },
                    "title": "Active Customers",
                    "description": "Customers with at least one completed order",
                    "config": {
                      "valueKey": "value",
                      "formatNumber": true,
                      "icon": "mdi:account-group",
                      "iconColor": "#6366f1"
                    },
                    "gridstack": {"x": 0, "y": 0, "w": 6, "h": 9},
                    "className": "w-[25.00%] h-[260px]",
                    "SA_RUNTIME": {"uiBlockId": "page-main"}
                  }
                }
              }
            },
            {
              "id": "widget-kpi-loyalty-rate",
              "dsl": {
                "id": "kpi-loyalty-rate",
                "name": "DynamicKPICard",
                "type": "KPICard",
                "description": "Percentage of customers enrolled in loyalty program",
                "render": {
                  "id": "render-kpi-loyalty-rate",
                  "type": "COMP_DYNAMICKPICARD",
                  "props": {
                    "query": null,
                    "externalTool": {
                      "toolId": "__IKEA_TOOL_ID__",
                      "toolName": "__IKEA_TOOL_NAME__",
                      "parameters": {
                        "sql": "SELECT ROUND(100.0 * COUNT(*) FILTER (WHERE is_loyalty_member = true) / COUNT(*), 1) as value FROM customers"
                      }
                    },
                    "title": "Loyalty Penetration",
                    "description": "Percentage of customers enrolled in loyalty program",
                    "config": {
                      "valueKey": "value",
                      "suffix": "%",
                      "formatNumber": true,
                      "icon": "mdi:heart",
                      "iconColor": "#ef4444"
                    },
                    "gridstack": {"x": 6, "y": 0, "w": 6, "h": 9},
                    "className": "w-[25.00%] h-[260px]",
                    "SA_RUNTIME": {"uiBlockId": "page-main"}
                  }
                }
              }
            },
            {
              "id": "widget-kpi-avg-clv",
              "dsl": {
                "id": "kpi-avg-clv",
                "name": "DynamicKPICard",
                "type": "KPICard",
                "description": "Average total spend per customer",
                "render": {
                  "id": "render-kpi-avg-clv",
                  "type": "COMP_DYNAMICKPICARD",
                  "props": {
                    "query": null,
                    "externalTool": {
                      "toolId": "__IKEA_TOOL_ID__",
                      "toolName": "__IKEA_TOOL_NAME__",
                      "parameters": {
                        "sql": "SELECT ROUND(AVG(total_spend), 2) as value FROM (SELECT customer_id, SUM(total_amount) as total_spend FROM orders WHERE status NOT IN ('Cancelled', 'Failed') GROUP BY customer_id) sub"
                      }
                    },
                    "title": "Avg Customer Lifetime Value",
                    "description": "Average total spend per customer",
                    "config": {
                      "valueKey": "value",
                      "prefix": "$",
                      "formatNumber": true,
                      "icon": "mdi:account-cash",
                      "iconColor": "#22c55e"
                    },
                    "gridstack": {"x": 12, "y": 0, "w": 6, "h": 9},
                    "className": "w-[25.00%] h-[260px]",
                    "SA_RUNTIME": {"uiBlockId": "page-main"}
                  }
                }
              }
            },
            {
              "id": "widget-kpi-avg-rating",
              "dsl": {
                "id": "kpi-avg-rating",
                "name": "DynamicKPICard",
                "type": "KPICard",
                "description": "Average product review score",
                "render": {
                  "id": "render-kpi-avg-rating",
                  "type": "COMP_DYNAMICKPICARD",
                  "props": {
                    "query": null,
                    "externalTool": {
                      "toolId": "__IKEA_TOOL_ID__",
                      "toolName": "__IKEA_TOOL_NAME__",
                      "parameters": {
                        "sql": "SELECT ROUND(AVG(rating), 2) as value FROM reviews"
                      }
                    },
                    "title": "Avg Customer Rating",
                    "description": "Average product review score",
                    "config": {
                      "valueKey": "value",
                      "suffix": " / 5",
                      "formatNumber": true,
                      "icon": "mdi:star",
                      "iconColor": "#eab308"
                    },
                    "gridstack": {"x": 18, "y": 0, "w": 6, "h": 9},
                    "className": "w-[25.00%] h-[260px]",
                    "SA_RUNTIME": {"uiBlockId": "page-main"}
                  }
                }
              }
            },
            {
              "id": "widget-chart-loyalty-revenue",
              "dsl": {
                "id": "chart-loyalty-revenue",
                "name": "DynamicPieChart",
                "type": "PieChart",
                "description": "Revenue contribution by loyalty membership status",
                "render": {
                  "id": "render-chart-loyalty-revenue",
                  "type": "COMP_DYNAMICPIECHART",
                  "props": {
                    "query": null,
                    "externalTool": {
                      "toolId": "__IKEA_TOOL_ID__",
                      "toolName": "__IKEA_TOOL_NAME__",
                      "parameters": {
                        "sql": "SELECT CASE WHEN c.is_loyalty_member THEN 'Loyalty Members' ELSE 'Non-Members' END as segment, SUM(o.total_amount) as revenue FROM orders o JOIN customers c ON o.customer_id = c.customer_id WHERE o.status NOT IN ('Cancelled', 'Failed') GROUP BY c.is_loyalty_member"
                      }
                    },
                    "title": "Revenue: Loyalty vs Non-Loyalty",
                    "description": "Revenue contribution by loyalty membership status",
                    "config": {
                      "nameKey": "segment",
                      "valueKey": "revenue",
                      "height": 400,
                      "showPercentage": true,
                      "donut": true,
                      "donutRadius": ["40%", "70%"],
                      "colorPalette": ["#6366f1", "#e2e8f0", "#22c55e", "#eab308"]
                    },
                    "gridstack": {"x": 0, "y": 9, "w": 12, "h": 28},
                    "className": "w-[50.00%] h-[830px]",
                    "SA_RUNTIME": {"uiBlockId": "page-main"}
                  }
                }
              }
            },
            {
              "id": "widget-chart-customer-acquisition",
              "dsl": {
                "id": "chart-customer-acquisition",
                "name": "DynamicLineChart",
                "type": "LineChart",
                "description": "New customer registrations over time",
                "render": {
                  "id": "render-chart-customer-acquisition",
                  "type": "COMP_DYNAMICLINECHART",
                  "props": {
                    "query": null,
                    "externalTool": {
                      "toolId": "__IKEA_TOOL_ID__",
                      "toolName": "__IKEA_TOOL_NAME__",
                      "parameters": {
                        "sql": "SELECT TO_CHAR(DATE_TRUNC('month', created_at), 'YYYY-MM') as month, COUNT(*) as new_customers FROM customers GROUP BY DATE_TRUNC('month', created_at) ORDER BY DATE_TRUNC('month', created_at)"
                      }
                    },
                    "title": "Monthly Customer Acquisition",
                    "description": "New customer registrations over time",
                    "config": {
                      "xAxisKey": "month",
                      "yAxisKey": "new_customers",
                      "xAxisLabel": "Month",
                      "yAxisLabel": "New Customers",
                      "height": 400,
                      "smooth": true,
                      "showArea": true,
                      "showDataPoints": true,
                      "colorPalette": ["#22c55e", "#6366f1", "#eab308", "#8B5CF6"]
                    },
                    "gridstack": {"x": 12, "y": 9, "w": 12, "h": 28},
                    "className": "w-[50.00%] h-[830px]",
                    "SA_RUNTIME": {"uiBlockId": "page-main"}
                  }
                }
              }
            },
            {
              "id": "widget-table-top-customers",
              "dsl": {
                "id": "table-top-customers",
                "name": "DynamicDataTable",
                "type": "DataTable",
                "description": "Highest-value customers ranked by total spend",
                "render": {
                  "id": "render-table-top-customers",
                  "type": "COMP_DYNAMICDATATABLE",
                  "props": {
                    "query": null,
                    "externalTool": {
                      "toolId": "__IKEA_TOOL_ID__",
                      "toolName": "__IKEA_TOOL_NAME__",
                      "parameters": {
                        "sql": "SELECT c.first_name || ' ' || c.last_name as customer_name, c.email, CASE WHEN c.is_loyalty_member THEN 'Yes' ELSE 'No' END as loyalty_member, COUNT(o.order_id) as total_orders, SUM(o.total_amount) as total_spend FROM customers c JOIN orders o ON c.customer_id = o.customer_id WHERE o.status NOT IN ('Cancelled', 'Failed') GROUP BY c.customer_id, c.first_name, c.last_name, c.email, c.is_loyalty_member ORDER BY total_spend DESC LIMIT 20"
                      }
                    },
                    "title": "Top 20 Customers by Spend",
                    "description": "Highest-value customers ranked by total spend",
                    "config": {
                      "pageSize": 10,
                      "showPagination": true,
                      "sortable": true,
                      "striped": true,
                      "hoverable": true,
                      "compact": false
                    },
                    "gridstack": {"x": 0, "y": 37, "w": 24, "h": 20},
                    "className": "w-[100.00%] h-[590px]",
                    "SA_RUNTIME": {"uiBlockId": "page-main"}
                  }
                }
              }
            }
          ]
        }
      }
    }]
  }
}$json$::jsonb,
    true,
    '[]'::jsonb
);

-- Dashboard 3: Channel & Fulfillment Operations
INSERT INTO dashboards (dashboard_id, project_id, name, description, dashboard, published, allowed_users)
VALUES (
    'ikea-channel-operations',
    :project_id,
    'Channel & Fulfillment Operations',
    'Order channels, delivery performance, and payment method analysis',
    $json${
  "dsl": {
    "id": "dashboard-ikea-channel-operations",
    "name": "Channel & Fulfillment Operations",
    "defaultPageId": "page-main",
    "pages": [{
      "id": "page-main",
      "name": "Main",
      "order": 0,
      "render": {
        "id": "render-page-main",
        "type": "GRID_DASHBOARD",
        "props": {
          "backgroundColor": "#ffffff",
          "columns": 24,
          "cellHeight": 20,
          "margin": 10,
          "widgets": [
            {
              "id": "widget-kpi-home-delivery",
              "dsl": {
                "id": "kpi-home-delivery",
                "name": "DynamicKPICard",
                "type": "KPICard",
                "description": "Orders fulfilled via home delivery",
                "render": {
                  "id": "render-kpi-home-delivery",
                  "type": "COMP_DYNAMICKPICARD",
                  "props": {
                    "query": null,
                    "externalTool": {
                      "toolId": "__IKEA_TOOL_ID__",
                      "toolName": "__IKEA_TOOL_NAME__",
                      "parameters": {
                        "sql": "SELECT COUNT(*) as value FROM orders WHERE delivery_method = 'home_delivery' AND status NOT IN ('Cancelled', 'Failed')"
                      }
                    },
                    "title": "Home Delivery Orders",
                    "description": "Orders fulfilled via home delivery",
                    "config": {
                      "valueKey": "value",
                      "formatNumber": true,
                      "icon": "mdi:truck-delivery",
                      "iconColor": "#6366f1"
                    },
                    "gridstack": {"x": 0, "y": 0, "w": 6, "h": 9},
                    "className": "w-[25.00%] h-[260px]",
                    "SA_RUNTIME": {"uiBlockId": "page-main"}
                  }
                }
              }
            },
            {
              "id": "widget-kpi-click-collect",
              "dsl": {
                "id": "kpi-click-collect",
                "name": "DynamicKPICard",
                "type": "KPICard",
                "description": "Orders picked up in store",
                "render": {
                  "id": "render-kpi-click-collect",
                  "type": "COMP_DYNAMICKPICARD",
                  "props": {
                    "query": null,
                    "externalTool": {
                      "toolId": "__IKEA_TOOL_ID__",
                      "toolName": "__IKEA_TOOL_NAME__",
                      "parameters": {
                        "sql": "SELECT COUNT(*) as value FROM orders WHERE delivery_method = 'click_and_collect' AND status NOT IN ('Cancelled', 'Failed')"
                      }
                    },
                    "title": "Click & Collect Orders",
                    "description": "Orders picked up in store",
                    "config": {
                      "valueKey": "value",
                      "formatNumber": true,
                      "icon": "mdi:store-marker",
                      "iconColor": "#8B5CF6"
                    },
                    "gridstack": {"x": 6, "y": 0, "w": 6, "h": 9},
                    "className": "w-[25.00%] h-[260px]",
                    "SA_RUNTIME": {"uiBlockId": "page-main"}
                  }
                }
              }
            },
            {
              "id": "widget-kpi-cancellation-rate",
              "dsl": {
                "id": "kpi-cancellation-rate",
                "name": "DynamicKPICard",
                "type": "KPICard",
                "description": "Percentage of orders cancelled or failed",
                "render": {
                  "id": "render-kpi-cancellation-rate",
                  "type": "COMP_DYNAMICKPICARD",
                  "props": {
                    "query": null,
                    "externalTool": {
                      "toolId": "__IKEA_TOOL_ID__",
                      "toolName": "__IKEA_TOOL_NAME__",
                      "parameters": {
                        "sql": "SELECT ROUND(100.0 * COUNT(*) FILTER (WHERE status IN ('Cancelled', 'Failed')) / COUNT(*), 1) as value FROM orders"
                      }
                    },
                    "title": "Cancellation Rate",
                    "description": "Percentage of orders cancelled or failed",
                    "config": {
                      "valueKey": "value",
                      "suffix": "%",
                      "formatNumber": true,
                      "icon": "mdi:close-circle",
                      "iconColor": "#ef4444"
                    },
                    "gridstack": {"x": 12, "y": 0, "w": 6, "h": 9},
                    "className": "w-[25.00%] h-[260px]",
                    "SA_RUNTIME": {"uiBlockId": "page-main"}
                  }
                }
              }
            },
            {
              "id": "widget-kpi-avg-delivery-fee",
              "dsl": {
                "id": "kpi-avg-delivery-fee",
                "name": "DynamicKPICard",
                "type": "KPICard",
                "description": "Average delivery fee for shipped orders",
                "render": {
                  "id": "render-kpi-avg-delivery-fee",
                  "type": "COMP_DYNAMICKPICARD",
                  "props": {
                    "query": null,
                    "externalTool": {
                      "toolId": "__IKEA_TOOL_ID__",
                      "toolName": "__IKEA_TOOL_NAME__",
                      "parameters": {
                        "sql": "SELECT ROUND(AVG(delivery_fee), 2) as value FROM orders WHERE delivery_fee > 0 AND status NOT IN ('Cancelled', 'Failed')"
                      }
                    },
                    "title": "Avg Delivery Fee",
                    "description": "Average delivery fee for shipped orders",
                    "config": {
                      "valueKey": "value",
                      "prefix": "$",
                      "formatNumber": true,
                      "icon": "mdi:cash",
                      "iconColor": "#22c55e"
                    },
                    "gridstack": {"x": 18, "y": 0, "w": 6, "h": 9},
                    "className": "w-[25.00%] h-[260px]",
                    "SA_RUNTIME": {"uiBlockId": "page-main"}
                  }
                }
              }
            },
            {
              "id": "widget-chart-channel-revenue",
              "dsl": {
                "id": "chart-channel-revenue",
                "name": "DynamicPieChart",
                "type": "PieChart",
                "description": "Revenue distribution across fulfillment channels",
                "render": {
                  "id": "render-chart-channel-revenue",
                  "type": "COMP_DYNAMICPIECHART",
                  "props": {
                    "query": null,
                    "externalTool": {
                      "toolId": "__IKEA_TOOL_ID__",
                      "toolName": "__IKEA_TOOL_NAME__",
                      "parameters": {
                        "sql": "SELECT REPLACE(delivery_method, '_', ' ') as channel, SUM(total_amount) as revenue FROM orders WHERE status NOT IN ('Cancelled', 'Failed') GROUP BY delivery_method ORDER BY revenue DESC"
                      }
                    },
                    "title": "Revenue by Delivery Channel",
                    "description": "Revenue distribution across fulfillment channels",
                    "config": {
                      "nameKey": "channel",
                      "valueKey": "revenue",
                      "height": 400,
                      "showPercentage": true,
                      "donut": true,
                      "donutRadius": ["40%", "70%"],
                      "colorPalette": ["#6366f1", "#8B5CF6", "#06b6d4", "#22c55e"]
                    },
                    "gridstack": {"x": 0, "y": 9, "w": 12, "h": 28},
                    "className": "w-[50.00%] h-[830px]",
                    "SA_RUNTIME": {"uiBlockId": "page-main"}
                  }
                }
              }
            },
            {
              "id": "widget-chart-order-status",
              "dsl": {
                "id": "chart-order-status",
                "name": "DynamicBarChart",
                "type": "BarChart",
                "description": "Distribution of orders by current status",
                "render": {
                  "id": "render-chart-order-status",
                  "type": "COMP_DYNAMICBARCHART",
                  "props": {
                    "query": null,
                    "externalTool": {
                      "toolId": "__IKEA_TOOL_ID__",
                      "toolName": "__IKEA_TOOL_NAME__",
                      "parameters": {
                        "sql": "SELECT status, COUNT(*) as order_count FROM orders GROUP BY status ORDER BY order_count DESC"
                      }
                    },
                    "title": "Order Status Breakdown",
                    "description": "Distribution of orders by current status",
                    "config": {
                      "xAxisKey": "status",
                      "yAxisKey": "order_count",
                      "xAxisLabel": "Status",
                      "yAxisLabel": "Orders",
                      "height": 400,
                      "orientation": "vertical",
                      "colorPalette": ["#22c55e", "#6366f1", "#eab308", "#ef4444", "#8B5CF6", "#06b6d4"]
                    },
                    "gridstack": {"x": 12, "y": 9, "w": 12, "h": 28},
                    "className": "w-[50.00%] h-[830px]",
                    "SA_RUNTIME": {"uiBlockId": "page-main"}
                  }
                }
              }
            },
            {
              "id": "widget-chart-payment-methods",
              "dsl": {
                "id": "chart-payment-methods",
                "name": "DynamicPieChart",
                "type": "PieChart",
                "description": "How customers prefer to pay",
                "render": {
                  "id": "render-chart-payment-methods",
                  "type": "COMP_DYNAMICPIECHART",
                  "props": {
                    "query": null,
                    "externalTool": {
                      "toolId": "__IKEA_TOOL_ID__",
                      "toolName": "__IKEA_TOOL_NAME__",
                      "parameters": {
                        "sql": "SELECT payment_method, COUNT(*) as order_count FROM orders WHERE status NOT IN ('Cancelled', 'Failed') GROUP BY payment_method ORDER BY order_count DESC"
                      }
                    },
                    "title": "Payment Method Distribution",
                    "description": "How customers prefer to pay",
                    "config": {
                      "nameKey": "payment_method",
                      "valueKey": "order_count",
                      "height": 400,
                      "showPercentage": true,
                      "donut": true,
                      "donutRadius": ["40%", "70%"],
                      "colorPalette": ["#6366f1", "#22c55e", "#eab308", "#ef4444", "#8B5CF6", "#06b6d4"]
                    },
                    "gridstack": {"x": 6, "y": 37, "w": 12, "h": 28},
                    "className": "w-[50.00%] h-[830px]",
                    "SA_RUNTIME": {"uiBlockId": "page-main"}
                  }
                }
              }
            }
          ]
        }
      }
    }]
  }
}$json$::jsonb,
    true,
    '[]'::jsonb
);

-- Dashboard 4: Product Portfolio & Quality
INSERT INTO dashboards (dashboard_id, project_id, name, description, dashboard, published, allowed_users)
VALUES (
    'ikea-product-portfolio',
    :project_id,
    'Product Portfolio & Quality',
    'Product catalog analysis, category performance, pricing strategy, and customer satisfaction scores',
    $json${
  "dsl": {
    "id": "dashboard-ikea-product-portfolio",
    "name": "Product Portfolio & Quality",
    "defaultPageId": "page-main",
    "pages": [{
      "id": "page-main",
      "name": "Main",
      "order": 0,
      "render": {
        "id": "render-page-main",
        "type": "GRID_DASHBOARD",
        "props": {
          "backgroundColor": "#ffffff",
          "columns": 24,
          "cellHeight": 20,
          "margin": 10,
          "widgets": [
            {
              "id": "widget-kpi-total-products",
              "dsl": {
                "id": "kpi-total-products",
                "name": "DynamicKPICard",
                "type": "KPICard",
                "description": "Products in the catalog",
                "render": {
                  "id": "render-kpi-total-products",
                  "type": "COMP_DYNAMICKPICARD",
                  "props": {
                    "query": null,
                    "externalTool": {
                      "toolId": "__IKEA_TOOL_ID__",
                      "toolName": "__IKEA_TOOL_NAME__",
                      "parameters": {
                        "sql": "SELECT COUNT(*) as value FROM products"
                      }
                    },
                    "title": "Total Products",
                    "description": "Products in the catalog",
                    "config": {
                      "valueKey": "value",
                      "formatNumber": true,
                      "icon": "mdi:package-variant",
                      "iconColor": "#6366f1"
                    },
                    "gridstack": {"x": 0, "y": 0, "w": 6, "h": 9},
                    "className": "w-[25.00%] h-[260px]",
                    "SA_RUNTIME": {"uiBlockId": "page-main"}
                  }
                }
              }
            },
            {
              "id": "widget-kpi-avg-product-rating",
              "dsl": {
                "id": "kpi-avg-product-rating",
                "name": "DynamicKPICard",
                "type": "KPICard",
                "description": "Average rating across all product reviews",
                "render": {
                  "id": "render-kpi-avg-product-rating",
                  "type": "COMP_DYNAMICKPICARD",
                  "props": {
                    "query": null,
                    "externalTool": {
                      "toolId": "__IKEA_TOOL_ID__",
                      "toolName": "__IKEA_TOOL_NAME__",
                      "parameters": {
                        "sql": "SELECT ROUND(AVG(rating), 2) as value FROM reviews"
                      }
                    },
                    "title": "Avg Product Rating",
                    "description": "Average rating across all product reviews",
                    "config": {
                      "valueKey": "value",
                      "suffix": " / 5",
                      "formatNumber": true,
                      "icon": "mdi:star",
                      "iconColor": "#eab308"
                    },
                    "gridstack": {"x": 6, "y": 0, "w": 6, "h": 9},
                    "className": "w-[25.00%] h-[260px]",
                    "SA_RUNTIME": {"uiBlockId": "page-main"}
                  }
                }
              }
            },
            {
              "id": "widget-kpi-active-variants",
              "dsl": {
                "id": "kpi-active-variants",
                "name": "DynamicKPICard",
                "type": "KPICard",
                "description": "Active product variants currently on discount",
                "render": {
                  "id": "render-kpi-active-variants",
                  "type": "COMP_DYNAMICKPICARD",
                  "props": {
                    "query": null,
                    "externalTool": {
                      "toolId": "__IKEA_TOOL_ID__",
                      "toolName": "__IKEA_TOOL_NAME__",
                      "parameters": {
                        "sql": "SELECT COUNT(*) as value FROM product_variants WHERE discount_percent > 0 AND is_active = true"
                      }
                    },
                    "title": "Discounted Variants",
                    "description": "Active product variants currently on discount",
                    "config": {
                      "valueKey": "value",
                      "formatNumber": true,
                      "icon": "mdi:tag-outline",
                      "iconColor": "#ef4444"
                    },
                    "gridstack": {"x": 12, "y": 0, "w": 6, "h": 9},
                    "className": "w-[25.00%] h-[260px]",
                    "SA_RUNTIME": {"uiBlockId": "page-main"}
                  }
                }
              }
            },
            {
              "id": "widget-kpi-total-reviews",
              "dsl": {
                "id": "kpi-total-reviews",
                "name": "DynamicKPICard",
                "type": "KPICard",
                "description": "Customer product reviews collected",
                "render": {
                  "id": "render-kpi-total-reviews",
                  "type": "COMP_DYNAMICKPICARD",
                  "props": {
                    "query": null,
                    "externalTool": {
                      "toolId": "__IKEA_TOOL_ID__",
                      "toolName": "__IKEA_TOOL_NAME__",
                      "parameters": {
                        "sql": "SELECT COUNT(*) as value FROM reviews"
                      }
                    },
                    "title": "Total Reviews",
                    "description": "Customer product reviews collected",
                    "config": {
                      "valueKey": "value",
                      "formatNumber": true,
                      "icon": "mdi:comment-text-multiple",
                      "iconColor": "#06b6d4"
                    },
                    "gridstack": {"x": 18, "y": 0, "w": 6, "h": 9},
                    "className": "w-[25.00%] h-[260px]",
                    "SA_RUNTIME": {"uiBlockId": "page-main"}
                  }
                }
              }
            },
            {
              "id": "widget-chart-category-revenue",
              "dsl": {
                "id": "chart-category-revenue",
                "name": "DynamicBarChart",
                "type": "BarChart",
                "description": "Highest-grossing product categories",
                "render": {
                  "id": "render-chart-category-revenue",
                  "type": "COMP_DYNAMICBARCHART",
                  "props": {
                    "query": null,
                    "externalTool": {
                      "toolId": "__IKEA_TOOL_ID__",
                      "toolName": "__IKEA_TOOL_NAME__",
                      "parameters": {
                        "sql": "SELECT c.name as category, SUM(oi.quantity * oi.price_at_purchase) as revenue, COUNT(DISTINCT p.product_id) as products FROM categories c JOIN products p ON c.category_id = p.category_id JOIN product_variants pv ON p.product_id = pv.product_id JOIN order_items oi ON pv.variant_id = oi.variant_id JOIN orders o ON oi.order_id = o.order_id WHERE o.status NOT IN ('Cancelled', 'Failed') GROUP BY c.name ORDER BY revenue DESC LIMIT 10"
                      }
                    },
                    "title": "Top 10 Categories by Revenue",
                    "description": "Highest-grossing product categories",
                    "config": {
                      "xAxisKey": "category",
                      "yAxisKey": "revenue",
                      "xAxisLabel": "Category",
                      "yAxisLabel": "Revenue ($)",
                      "height": 400,
                      "orientation": "horizontal",
                      "colorPalette": ["#6366f1", "#22c55e", "#eab308", "#8B5CF6"]
                    },
                    "gridstack": {"x": 0, "y": 9, "w": 12, "h": 28},
                    "className": "w-[50.00%] h-[830px]",
                    "SA_RUNTIME": {"uiBlockId": "page-main"}
                  }
                }
              }
            },
            {
              "id": "widget-chart-rating-distribution",
              "dsl": {
                "id": "chart-rating-distribution",
                "name": "DynamicBarChart",
                "type": "BarChart",
                "description": "Distribution of customer review scores (1-5 stars)",
                "render": {
                  "id": "render-chart-rating-distribution",
                  "type": "COMP_DYNAMICBARCHART",
                  "props": {
                    "query": null,
                    "externalTool": {
                      "toolId": "__IKEA_TOOL_ID__",
                      "toolName": "__IKEA_TOOL_NAME__",
                      "parameters": {
                        "sql": "SELECT rating as stars, COUNT(*) as review_count FROM reviews GROUP BY rating ORDER BY rating"
                      }
                    },
                    "title": "Rating Distribution",
                    "description": "Distribution of customer review scores (1-5 stars)",
                    "config": {
                      "xAxisKey": "stars",
                      "yAxisKey": "review_count",
                      "xAxisLabel": "Stars",
                      "yAxisLabel": "Reviews",
                      "height": 400,
                      "orientation": "vertical",
                      "colorPalette": ["#ef4444", "#eab308", "#eab308", "#22c55e", "#22c55e"]
                    },
                    "gridstack": {"x": 12, "y": 9, "w": 12, "h": 28},
                    "className": "w-[50.00%] h-[830px]",
                    "SA_RUNTIME": {"uiBlockId": "page-main"}
                  }
                }
              }
            },
            {
              "id": "widget-table-top-products",
              "dsl": {
                "id": "table-top-products",
                "name": "DynamicDataTable",
                "type": "DataTable",
                "description": "Best-selling products with units sold, revenue, and customer ratings",
                "render": {
                  "id": "render-table-top-products",
                  "type": "COMP_DYNAMICDATATABLE",
                  "props": {
                    "query": null,
                    "externalTool": {
                      "toolId": "__IKEA_TOOL_ID__",
                      "toolName": "__IKEA_TOOL_NAME__",
                      "parameters": {
                        "sql": "SELECT p.name as product, c.name as category, SUM(oi.quantity) as units_sold, SUM(oi.quantity * oi.price_at_purchase) as revenue, ROUND(AVG(r.rating), 2) as avg_rating FROM products p JOIN categories c ON p.category_id = c.category_id JOIN product_variants pv ON p.product_id = pv.product_id JOIN order_items oi ON pv.variant_id = oi.variant_id JOIN orders o ON oi.order_id = o.order_id LEFT JOIN reviews r ON p.product_id = r.product_id WHERE o.status NOT IN ('Cancelled', 'Failed') GROUP BY p.product_id, p.name, c.name ORDER BY revenue DESC LIMIT 20"
                      }
                    },
                    "title": "Top 20 Products by Revenue",
                    "description": "Best-selling products with units sold, revenue, and customer ratings",
                    "config": {
                      "pageSize": 10,
                      "showPagination": true,
                      "sortable": true,
                      "striped": true,
                      "hoverable": true,
                      "compact": false
                    },
                    "gridstack": {"x": 0, "y": 37, "w": 24, "h": 20},
                    "className": "w-[100.00%] h-[590px]",
                    "SA_RUNTIME": {"uiBlockId": "page-main"}
                  }
                }
              }
            }
          ]
        }
      }
    }]
  }
}$json$::jsonb,
    true,
    '[]'::jsonb
);

-- Dashboard 5: Store & Geographic Performance
INSERT INTO dashboards (dashboard_id, project_id, name, description, dashboard, published, allowed_users)
VALUES (
    'ikea-store-performance',
    :project_id,
    'Store & Geographic Performance',
    'Store-level revenue, geographic distribution, and store type comparison',
    $json${
  "dsl": {
    "id": "dashboard-ikea-store-performance",
    "name": "Store & Geographic Performance",
    "defaultPageId": "page-main",
    "pages": [{
      "id": "page-main",
      "name": "Main",
      "order": 0,
      "render": {
        "id": "render-page-main",
        "type": "GRID_DASHBOARD",
        "props": {
          "backgroundColor": "#ffffff",
          "columns": 24,
          "cellHeight": 20,
          "margin": 10,
          "widgets": [
            {
              "id": "widget-kpi-total-stores",
              "dsl": {
                "id": "kpi-total-stores",
                "name": "DynamicKPICard",
                "type": "KPICard",
                "description": "IKEA retail locations",
                "render": {
                  "id": "render-kpi-total-stores",
                  "type": "COMP_DYNAMICKPICARD",
                  "props": {
                    "query": null,
                    "externalTool": {
                      "toolId": "__IKEA_TOOL_ID__",
                      "toolName": "__IKEA_TOOL_NAME__",
                      "parameters": {
                        "sql": "SELECT COUNT(*) as value FROM locations"
                      }
                    },
                    "title": "Total Stores",
                    "description": "IKEA retail locations",
                    "config": {
                      "valueKey": "value",
                      "formatNumber": true,
                      "icon": "mdi:store",
                      "iconColor": "#6366f1"
                    },
                    "gridstack": {"x": 0, "y": 0, "w": 8, "h": 9},
                    "className": "w-[33.33%] h-[260px]",
                    "SA_RUNTIME": {"uiBlockId": "page-main"}
                  }
                }
              }
            },
            {
              "id": "widget-kpi-avg-revenue-per-store",
              "dsl": {
                "id": "kpi-avg-revenue-per-store",
                "name": "DynamicKPICard",
                "type": "KPICard",
                "description": "Average total revenue generated per store",
                "render": {
                  "id": "render-kpi-avg-revenue-per-store",
                  "type": "COMP_DYNAMICKPICARD",
                  "props": {
                    "query": null,
                    "externalTool": {
                      "toolId": "__IKEA_TOOL_ID__",
                      "toolName": "__IKEA_TOOL_NAME__",
                      "parameters": {
                        "sql": "SELECT ROUND(AVG(store_revenue), 2) as value FROM (SELECT store_id, SUM(total_amount) as store_revenue FROM orders WHERE store_id IS NOT NULL AND status NOT IN ('Cancelled', 'Failed') GROUP BY store_id) sub"
                      }
                    },
                    "title": "Avg Revenue per Store",
                    "description": "Average total revenue generated per store",
                    "config": {
                      "valueKey": "value",
                      "prefix": "$",
                      "formatNumber": true,
                      "icon": "mdi:cash-register",
                      "iconColor": "#22c55e"
                    },
                    "gridstack": {"x": 8, "y": 0, "w": 8, "h": 9},
                    "className": "w-[33.33%] h-[260px]",
                    "SA_RUNTIME": {"uiBlockId": "page-main"}
                  }
                }
              }
            },
            {
              "id": "widget-kpi-states-covered",
              "dsl": {
                "id": "kpi-states-covered",
                "name": "DynamicKPICard",
                "type": "KPICard",
                "description": "Number of US states with IKEA presence",
                "render": {
                  "id": "render-kpi-states-covered",
                  "type": "COMP_DYNAMICKPICARD",
                  "props": {
                    "query": null,
                    "externalTool": {
                      "toolId": "__IKEA_TOOL_ID__",
                      "toolName": "__IKEA_TOOL_NAME__",
                      "parameters": {
                        "sql": "SELECT COUNT(DISTINCT state) as value FROM locations WHERE state IS NOT NULL"
                      }
                    },
                    "title": "States Covered",
                    "description": "Number of US states with IKEA presence",
                    "config": {
                      "valueKey": "value",
                      "formatNumber": true,
                      "icon": "mdi:map-marker-radius",
                      "iconColor": "#8B5CF6"
                    },
                    "gridstack": {"x": 16, "y": 0, "w": 8, "h": 9},
                    "className": "w-[33.33%] h-[260px]",
                    "SA_RUNTIME": {"uiBlockId": "page-main"}
                  }
                }
              }
            },
            {
              "id": "widget-chart-top-stores",
              "dsl": {
                "id": "chart-top-stores",
                "name": "DynamicBarChart",
                "type": "BarChart",
                "description": "Highest revenue-generating store locations",
                "render": {
                  "id": "render-chart-top-stores",
                  "type": "COMP_DYNAMICBARCHART",
                  "props": {
                    "query": null,
                    "externalTool": {
                      "toolId": "__IKEA_TOOL_ID__",
                      "toolName": "__IKEA_TOOL_NAME__",
                      "parameters": {
                        "sql": "SELECT l.location_name as store, SUM(o.total_amount) as revenue FROM locations l JOIN orders o ON l.location_id = o.store_id WHERE o.status NOT IN ('Cancelled', 'Failed') GROUP BY l.location_id, l.location_name ORDER BY revenue DESC LIMIT 10"
                      }
                    },
                    "title": "Top 10 Stores by Revenue",
                    "description": "Highest revenue-generating store locations",
                    "config": {
                      "xAxisKey": "store",
                      "yAxisKey": "revenue",
                      "xAxisLabel": "Store",
                      "yAxisLabel": "Revenue ($)",
                      "height": 400,
                      "orientation": "horizontal",
                      "colorPalette": ["#6366f1", "#22c55e", "#eab308", "#8B5CF6"]
                    },
                    "gridstack": {"x": 0, "y": 9, "w": 12, "h": 28},
                    "className": "w-[50.00%] h-[830px]",
                    "SA_RUNTIME": {"uiBlockId": "page-main"}
                  }
                }
              }
            },
            {
              "id": "widget-chart-store-type-revenue",
              "dsl": {
                "id": "chart-store-type-revenue",
                "name": "DynamicPieChart",
                "type": "PieChart",
                "description": "Revenue comparison between full-size and small format stores",
                "render": {
                  "id": "render-chart-store-type-revenue",
                  "type": "COMP_DYNAMICPIECHART",
                  "props": {
                    "query": null,
                    "externalTool": {
                      "toolId": "__IKEA_TOOL_ID__",
                      "toolName": "__IKEA_TOOL_NAME__",
                      "parameters": {
                        "sql": "SELECT l.location_type as store_type, SUM(o.total_amount) as revenue FROM locations l JOIN orders o ON l.location_id = o.store_id WHERE o.status NOT IN ('Cancelled', 'Failed') GROUP BY l.location_type ORDER BY revenue DESC"
                      }
                    },
                    "title": "Revenue by Store Type",
                    "description": "Revenue comparison between full-size and small format stores",
                    "config": {
                      "nameKey": "store_type",
                      "valueKey": "revenue",
                      "height": 400,
                      "showPercentage": true,
                      "donut": true,
                      "donutRadius": ["40%", "70%"],
                      "colorPalette": ["#6366f1", "#8B5CF6", "#06b6d4", "#22c55e"]
                    },
                    "gridstack": {"x": 12, "y": 9, "w": 12, "h": 28},
                    "className": "w-[50.00%] h-[830px]",
                    "SA_RUNTIME": {"uiBlockId": "page-main"}
                  }
                }
              }
            },
            {
              "id": "widget-table-store-details",
              "dsl": {
                "id": "table-store-details",
                "name": "DynamicDataTable",
                "type": "DataTable",
                "description": "Complete store performance breakdown by location",
                "render": {
                  "id": "render-table-store-details",
                  "type": "COMP_DYNAMICDATATABLE",
                  "props": {
                    "query": null,
                    "externalTool": {
                      "toolId": "__IKEA_TOOL_ID__",
                      "toolName": "__IKEA_TOOL_NAME__",
                      "parameters": {
                        "sql": "SELECT l.location_name as store, l.city, l.state, l.location_type as type, COUNT(DISTINCT o.order_id) as orders, SUM(o.total_amount) as revenue, ROUND(AVG(o.total_amount), 2) as avg_order_value FROM locations l JOIN orders o ON l.location_id = o.store_id WHERE o.status NOT IN ('Cancelled', 'Failed') GROUP BY l.location_id, l.location_name, l.city, l.state, l.location_type ORDER BY revenue DESC"
                      }
                    },
                    "title": "Store Performance Details",
                    "description": "Complete store performance breakdown by location",
                    "config": {
                      "pageSize": 10,
                      "showPagination": true,
                      "sortable": true,
                      "striped": true,
                      "hoverable": true,
                      "compact": false
                    },
                    "gridstack": {"x": 0, "y": 37, "w": 24, "h": 20},
                    "className": "w-[100.00%] h-[590px]",
                    "SA_RUNTIME": {"uiBlockId": "page-main"}
                  }
                }
              }
            }
          ]
        }
      }
    }]
  }
}$json$::jsonb,
    true,
    '[]'::jsonb
);

-- Dashboard 6: Order Explorer (Interactive Filter)
INSERT INTO dashboards (dashboard_id, project_id, name, description, dashboard, published, allowed_users)
VALUES (
    'ikea-order-explorer',
    :project_id,
    'Order Explorer (Interactive)',
    'Interactive dashboard with order status filter — drill into any status to see revenue, volume, and order details',
    $json${
  "dsl": {
    "id": "dashboard-ikea-order-explorer",
    "name": "Order Explorer (Interactive)",
    "defaultPageId": "page-main",
    "pages": [{
      "id": "page-main",
      "name": "Main",
      "order": 0,
      "render": {
        "id": "render-page-main",
        "type": "GRID_DASHBOARD",
        "props": {
          "backgroundColor": "#ffffff",
          "columns": 24,
          "cellHeight": 20,
          "margin": 10,
          "widgets": [
            {
              "id": "widget-filter-order-status",
              "dsl": {
                "id": "filter-order-status",
                "name": "DynamicFilterDropdown",
                "type": "FilterDropdown",
                "description": "Filter all widgets by order status",
                "render": {
                  "id": "render-filter-order-status",
                  "type": "COMP_DYNAMICFILTERDROPDOWN",
                  "props": {
                    "title": "Order Status",
                    "filterKey": "status",
                    "filters": [
                      {"label": "All Orders", "value": "ALL", "params": {"status_filter": "ALL"}, "isDefault": true},
                      {"label": "Delivered", "value": "Delivered", "params": {"status_filter": "Delivered"}},
                      {"label": "Shipped", "value": "Shipped", "params": {"status_filter": "Shipped"}},
                      {"label": "Processing", "value": "Processing", "params": {"status_filter": "Processing"}},
                      {"label": "Pending", "value": "Pending", "params": {"status_filter": "Pending"}},
                      {"label": "Cancelled", "value": "Cancelled", "params": {"status_filter": "Cancelled"}}
                    ],
                    "defaultValue": "ALL",
                    "gridstack": {"x": 18, "y": 0, "w": 6, "h": 9},
                    "className": "w-[25.00%] h-[260px]",
                    "SA_RUNTIME": {"uiBlockId": "page-main"}
                  }
                }
              }
            },
            {
              "id": "widget-kpi-filtered-orders",
              "dsl": {
                "id": "kpi-filtered-orders",
                "name": "DynamicKPICard",
                "type": "KPICard",
                "description": "Order count for selected status",
                "render": {
                  "id": "render-kpi-filtered-orders",
                  "type": "COMP_DYNAMICKPICARD",
                  "props": {
                    "query": null,
                    "externalTool": {
                      "toolId": "__IKEA_TOOL_ID__",
                      "toolName": "__IKEA_TOOL_NAME__",
                      "parameters": {
                        "sql": "SELECT COUNT(*) as value FROM orders WHERE (@status_filter = 'ALL' OR status = @status_filter)",
                        "params": {"status_filter": "ALL"}
                      }
                    },
                    "title": "{%statusLabel%} — Order Count",
                    "description": "Orders matching {%statusLabel%} status",
                    "config": {
                      "valueKey": "value",
                      "formatNumber": true,
                      "icon": "mdi:cart-outline",
                      "iconColor": "#6366f1"
                    },
                    "gridstack": {"x": 0, "y": 0, "w": 6, "h": 9},
                    "className": "w-[25.00%] h-[260px]",
                    "SA_RUNTIME": {"uiBlockId": "page-main"}
                  }
                }
              }
            },
            {
              "id": "widget-kpi-filtered-revenue",
              "dsl": {
                "id": "kpi-filtered-revenue",
                "name": "DynamicKPICard",
                "type": "KPICard",
                "description": "Total revenue for selected status",
                "render": {
                  "id": "render-kpi-filtered-revenue",
                  "type": "COMP_DYNAMICKPICARD",
                  "props": {
                    "query": null,
                    "externalTool": {
                      "toolId": "__IKEA_TOOL_ID__",
                      "toolName": "__IKEA_TOOL_NAME__",
                      "parameters": {
                        "sql": "SELECT ROUND(SUM(total_amount), 2) as value FROM orders WHERE (@status_filter = 'ALL' OR status = @status_filter)",
                        "params": {"status_filter": "ALL"}
                      }
                    },
                    "title": "{%statusLabel%} — Total Revenue",
                    "description": "Revenue for {%statusLabel%} orders",
                    "config": {
                      "valueKey": "value",
                      "prefix": "$",
                      "formatNumber": true,
                      "icon": "mdi:currency-usd",
                      "iconColor": "#22c55e"
                    },
                    "gridstack": {"x": 6, "y": 0, "w": 6, "h": 9},
                    "className": "w-[25.00%] h-[260px]",
                    "SA_RUNTIME": {"uiBlockId": "page-main"}
                  }
                }
              }
            },
            {
              "id": "widget-kpi-filtered-avg-order",
              "dsl": {
                "id": "kpi-filtered-avg-order",
                "name": "DynamicKPICard",
                "type": "KPICard",
                "description": "Average order value for selected status",
                "render": {
                  "id": "render-kpi-filtered-avg-order",
                  "type": "COMP_DYNAMICKPICARD",
                  "props": {
                    "query": null,
                    "externalTool": {
                      "toolId": "__IKEA_TOOL_ID__",
                      "toolName": "__IKEA_TOOL_NAME__",
                      "parameters": {
                        "sql": "SELECT ROUND(AVG(total_amount), 2) as value FROM orders WHERE (@status_filter = 'ALL' OR status = @status_filter)",
                        "params": {"status_filter": "ALL"}
                      }
                    },
                    "title": "{%statusLabel%} — Avg Order Value",
                    "description": "Average per-order amount for {%statusLabel%}",
                    "config": {
                      "valueKey": "value",
                      "prefix": "$",
                      "formatNumber": true,
                      "icon": "mdi:receipt-text",
                      "iconColor": "#8B5CF6"
                    },
                    "gridstack": {"x": 12, "y": 0, "w": 6, "h": 9},
                    "className": "w-[25.00%] h-[260px]",
                    "SA_RUNTIME": {"uiBlockId": "page-main"}
                  }
                }
              }
            },
            {
              "id": "widget-chart-filtered-monthly",
              "dsl": {
                "id": "chart-filtered-monthly",
                "name": "DynamicLineChart",
                "type": "LineChart",
                "description": "Monthly revenue trend for selected status",
                "render": {
                  "id": "render-chart-filtered-monthly",
                  "type": "COMP_DYNAMICLINECHART",
                  "props": {
                    "query": null,
                    "externalTool": {
                      "toolId": "__IKEA_TOOL_ID__",
                      "toolName": "__IKEA_TOOL_NAME__",
                      "parameters": {
                        "sql": "SELECT TO_CHAR(DATE_TRUNC('month', order_date), 'YYYY-MM') as month, COUNT(*) as orders, SUM(total_amount) as revenue FROM orders WHERE (@status_filter = 'ALL' OR status = @status_filter) GROUP BY DATE_TRUNC('month', order_date) ORDER BY DATE_TRUNC('month', order_date)",
                        "params": {"status_filter": "ALL"}
                      }
                    },
                    "title": "{%statusLabel%} — Monthly Revenue Trend",
                    "description": "Revenue by month for {%statusLabel%}",
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
                    },
                    "gridstack": {"x": 0, "y": 9, "w": 12, "h": 28},
                    "className": "w-[50.00%] h-[830px]",
                    "SA_RUNTIME": {"uiBlockId": "page-main"}
                  }
                }
              }
            },
            {
              "id": "widget-chart-filtered-channels",
              "dsl": {
                "id": "chart-filtered-channels",
                "name": "DynamicBarChart",
                "type": "BarChart",
                "description": "Orders by delivery channel for selected status",
                "render": {
                  "id": "render-chart-filtered-channels",
                  "type": "COMP_DYNAMICBARCHART",
                  "props": {
                    "query": null,
                    "externalTool": {
                      "toolId": "__IKEA_TOOL_ID__",
                      "toolName": "__IKEA_TOOL_NAME__",
                      "parameters": {
                        "sql": "SELECT REPLACE(delivery_method, '_', ' ') as channel, COUNT(*) as order_count FROM orders WHERE (@status_filter = 'ALL' OR status = @status_filter) GROUP BY delivery_method ORDER BY order_count DESC",
                        "params": {"status_filter": "ALL"}
                      }
                    },
                    "title": "{%statusLabel%} — Orders by Delivery Channel",
                    "description": "Volume per delivery method for {%statusLabel%}",
                    "config": {
                      "xAxisKey": "channel",
                      "yAxisKey": "order_count",
                      "xAxisLabel": "Channel",
                      "yAxisLabel": "Orders",
                      "height": 400,
                      "orientation": "vertical",
                      "colorPalette": ["#6366f1", "#8B5CF6", "#22c55e", "#eab308"]
                    },
                    "gridstack": {"x": 12, "y": 9, "w": 12, "h": 28},
                    "className": "w-[50.00%] h-[830px]",
                    "SA_RUNTIME": {"uiBlockId": "page-main"}
                  }
                }
              }
            },
            {
              "id": "widget-table-filtered-orders",
              "dsl": {
                "id": "table-filtered-orders",
                "name": "DynamicDataTable",
                "type": "DataTable",
                "description": "Order details for selected status",
                "render": {
                  "id": "render-table-filtered-orders",
                  "type": "COMP_DYNAMICDATATABLE",
                  "props": {
                    "query": null,
                    "externalTool": {
                      "toolId": "__IKEA_TOOL_ID__",
                      "toolName": "__IKEA_TOOL_NAME__",
                      "parameters": {
                        "sql": "SELECT o.order_id, c.first_name || ' ' || c.last_name as customer, o.order_date, o.status, o.total_amount, REPLACE(o.delivery_method, '_', ' ') as delivery_method, o.payment_method FROM orders o JOIN customers c ON o.customer_id = c.customer_id WHERE (@status_filter = 'ALL' OR o.status = @status_filter) ORDER BY o.order_date DESC LIMIT 20",
                        "params": {"status_filter": "ALL"}
                      }
                    },
                    "title": "{%statusLabel%} — Order Details",
                    "description": "Recent {%statusLabel%} orders",
                    "config": {
                      "pageSize": 10,
                      "showPagination": true,
                      "sortable": true,
                      "striped": true,
                      "hoverable": true,
                      "compact": false
                    },
                    "gridstack": {"x": 0, "y": 37, "w": 24, "h": 20},
                    "className": "w-[100.00%] h-[590px]",
                    "SA_RUNTIME": {"uiBlockId": "page-main"}
                  }
                }
              }
            }
          ]
        }
      }
    }]
  }
}$json$::jsonb,
    true,
    '[]'::jsonb
);
