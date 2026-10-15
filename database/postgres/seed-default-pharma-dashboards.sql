-- =============================================================================
-- Default Dashboards for Pharma Dataset
-- Seeded during setup for CIO/CTO demo experience
-- Uses :project_id psql variable for project association
-- Format: Pages-based GridStack widget DSL (matches sa-platform-ui)
-- =============================================================================

-- Clean up existing default pharma dashboards for this project (idempotent)
DELETE FROM dashboards WHERE dashboard_id IN (
    'pharma-mfg-operations',
    'pharma-supply-chain',
    'pharma-quality-compliance',
    'pharma-regulatory-training',
    'pharma-cost-risk',
    'pharma-batch-explorer'
) AND project_id = :project_id;

-- Dashboard 1: Manufacturing Operations Overview
INSERT INTO dashboards (dashboard_id, project_id, name, description, dashboard, published, allowed_users)
VALUES (
    'pharma-mfg-operations',
    :project_id,
    'Manufacturing Operations Overview',
    'Executive snapshot of batch manufacturing — production volume, yield efficiency, and deviation trends',
    $json${
  "dsl": {
    "id": "dashboard-pharma-mfg-operations",
    "name": "Manufacturing Operations Overview",
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
              "id": "widget-kpi-total-batches",
              "dsl": {
                "id": "kpi-total-batches",
                "name": "DynamicKPICard",
                "type": "KPICard",
                "description": "Total manufacturing batches",
                "render": {
                  "id": "render-kpi-total-batches",
                  "type": "COMP_DYNAMICKPICARD",
                  "props": {
                    "query": null,
                    "externalTool": {
                      "toolId": "__PHARMA_TOOL_ID__",
                      "toolName": "__PHARMA_TOOL_NAME__",
                      "parameters": {
                        "sql": "SELECT COUNT(*) as value FROM mfg_batch_master"
                      }
                    },
                    "title": "Total Batches",
                    "description": "Total manufacturing batches",
                    "config": {
                      "valueKey": "value",
                      "formatNumber": true,
                      "icon": "mdi:flask",
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
              "id": "widget-kpi-avg-yield",
              "dsl": {
                "id": "kpi-avg-yield",
                "name": "DynamicKPICard",
                "type": "KPICard",
                "description": "Average batch yield percentage",
                "render": {
                  "id": "render-kpi-avg-yield",
                  "type": "COMP_DYNAMICKPICARD",
                  "props": {
                    "query": null,
                    "externalTool": {
                      "toolId": "__PHARMA_TOOL_ID__",
                      "toolName": "__PHARMA_TOOL_NAME__",
                      "parameters": {
                        "sql": "SELECT ROUND(AVG(yield_percent)::numeric, 1) as value FROM mfg_batch_master WHERE yield_percent IS NOT NULL"
                      }
                    },
                    "title": "Average Yield",
                    "description": "Average batch yield percentage",
                    "config": {
                      "valueKey": "value",
                      "suffix": "%",
                      "formatNumber": true,
                      "icon": "mdi:chart-line",
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
              "id": "widget-kpi-deviation-count",
              "dsl": {
                "id": "kpi-deviation-count",
                "name": "DynamicKPICard",
                "type": "KPICard",
                "description": "Total batch deviations recorded",
                "render": {
                  "id": "render-kpi-deviation-count",
                  "type": "COMP_DYNAMICKPICARD",
                  "props": {
                    "query": null,
                    "externalTool": {
                      "toolId": "__PHARMA_TOOL_ID__",
                      "toolName": "__PHARMA_TOOL_NAME__",
                      "parameters": {
                        "sql": "SELECT COUNT(*) as value FROM mfg_batch_deviations"
                      }
                    },
                    "title": "Total Deviations",
                    "description": "Total batch deviations recorded",
                    "config": {
                      "valueKey": "value",
                      "formatNumber": true,
                      "icon": "mdi:alert-circle",
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
              "id": "widget-kpi-failed-batches",
              "dsl": {
                "id": "kpi-failed-batches",
                "name": "DynamicKPICard",
                "type": "KPICard",
                "description": "Batches with failed status",
                "render": {
                  "id": "render-kpi-failed-batches",
                  "type": "COMP_DYNAMICKPICARD",
                  "props": {
                    "query": null,
                    "externalTool": {
                      "toolId": "__PHARMA_TOOL_ID__",
                      "toolName": "__PHARMA_TOOL_NAME__",
                      "parameters": {
                        "sql": "SELECT COUNT(*) as value FROM mfg_batch_master WHERE status = 'Failed'"
                      }
                    },
                    "title": "Failed Batches",
                    "description": "Batches with failed status",
                    "config": {
                      "valueKey": "value",
                      "formatNumber": true,
                      "icon": "mdi:close-circle",
                      "iconColor": "#f97316"
                    },
                    "gridstack": {"x": 18, "y": 0, "w": 6, "h": 9},
                    "className": "w-[25.00%] h-[260px]",
                    "SA_RUNTIME": {"uiBlockId": "page-main"}
                  }
                }
              }
            },
            {
              "id": "widget-bar-batch-facility",
              "dsl": {
                "id": "bar-batch-facility",
                "name": "DynamicBarChart",
                "type": "BarChart",
                "description": "Batch status breakdown by manufacturing facility",
                "render": {
                  "id": "render-bar-batch-facility",
                  "type": "COMP_DYNAMICBARCHART",
                  "props": {
                    "query": null,
                    "externalTool": {
                      "toolId": "__PHARMA_TOOL_ID__",
                      "toolName": "__PHARMA_TOOL_NAME__",
                      "parameters": {
                        "sql": "SELECT facility as label, status as category, COUNT(*) as value FROM mfg_batch_master GROUP BY facility, status ORDER BY facility"
                      }
                    },
                    "title": "Batch Status by Facility",
                    "description": "Batch status breakdown by manufacturing facility",
                    "config": {
                      "xAxisKey": "label",
                      "yAxisKey": "value",
                      "categoryKey": "category"
                    },
                    "gridstack": {"x": 0, "y": 9, "w": 12, "h": 28},
                    "className": "w-[50.00%] h-[830px]",
                    "SA_RUNTIME": {"uiBlockId": "page-main"}
                  }
                }
              }
            },
            {
              "id": "widget-bar-yield-product",
              "dsl": {
                "id": "bar-yield-product",
                "name": "DynamicBarChart",
                "type": "BarChart",
                "description": "Average yield percentage by product type",
                "render": {
                  "id": "render-bar-yield-product",
                  "type": "COMP_DYNAMICBARCHART",
                  "props": {
                    "query": null,
                    "externalTool": {
                      "toolId": "__PHARMA_TOOL_ID__",
                      "toolName": "__PHARMA_TOOL_NAME__",
                      "parameters": {
                        "sql": "SELECT product_type as label, ROUND(AVG(yield_percent)::numeric, 1) as value FROM mfg_batch_master WHERE yield_percent IS NOT NULL GROUP BY product_type ORDER BY product_type"
                      }
                    },
                    "title": "Average Yield by Product Type",
                    "description": "Average yield percentage by product type",
                    "config": {
                      "xAxisKey": "label",
                      "yAxisKey": "value"
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

-- Dashboard 2: Supply Chain & Procurement
INSERT INTO dashboards (dashboard_id, project_id, name, description, dashboard, published, allowed_users)
VALUES (
    'pharma-supply-chain',
    :project_id,
    'Supply Chain & Procurement',
    'End-to-end supply chain visibility — purchase orders, shipments, inventory levels, and supplier overview',
    $json${
  "dsl": {
    "id": "dashboard-pharma-supply-chain",
    "name": "Supply Chain & Procurement",
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
              "id": "widget-kpi-po-value",
              "dsl": {
                "id": "kpi-po-value",
                "name": "DynamicKPICard",
                "type": "KPICard",
                "description": "Total purchase order value",
                "render": {
                  "id": "render-kpi-po-value",
                  "type": "COMP_DYNAMICKPICARD",
                  "props": {
                    "query": null,
                    "externalTool": {
                      "toolId": "__PHARMA_TOOL_ID__",
                      "toolName": "__PHARMA_TOOL_NAME__",
                      "parameters": {
                        "sql": "SELECT ROUND(SUM(total_value)::numeric, 0) as value FROM sc_purchase_order_master"
                      }
                    },
                    "title": "Total PO Value",
                    "description": "Total purchase order value",
                    "config": {
                      "valueKey": "value",
                      "prefix": "$",
                      "formatNumber": true,
                      "icon": "mdi:cart",
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
              "id": "widget-kpi-active-shipments",
              "dsl": {
                "id": "kpi-active-shipments",
                "name": "DynamicKPICard",
                "type": "KPICard",
                "description": "Shipments in transit or pending",
                "render": {
                  "id": "render-kpi-active-shipments",
                  "type": "COMP_DYNAMICKPICARD",
                  "props": {
                    "query": null,
                    "externalTool": {
                      "toolId": "__PHARMA_TOOL_ID__",
                      "toolName": "__PHARMA_TOOL_NAME__",
                      "parameters": {
                        "sql": "SELECT COUNT(*) as value FROM sc_shipment_master WHERE status IN ('In Transit', 'Pending')"
                      }
                    },
                    "title": "Active Shipments",
                    "description": "Shipments in transit or pending",
                    "config": {
                      "valueKey": "value",
                      "formatNumber": true,
                      "icon": "mdi:truck-delivery",
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
              "id": "widget-kpi-inventory-items",
              "dsl": {
                "id": "kpi-inventory-items",
                "name": "DynamicKPICard",
                "type": "KPICard",
                "description": "Available inventory items",
                "render": {
                  "id": "render-kpi-inventory-items",
                  "type": "COMP_DYNAMICKPICARD",
                  "props": {
                    "query": null,
                    "externalTool": {
                      "toolId": "__PHARMA_TOOL_ID__",
                      "toolName": "__PHARMA_TOOL_NAME__",
                      "parameters": {
                        "sql": "SELECT COUNT(*) as value FROM sc_inventory_master WHERE status = 'Available'"
                      }
                    },
                    "title": "Available Inventory",
                    "description": "Available inventory items",
                    "config": {
                      "valueKey": "value",
                      "formatNumber": true,
                      "icon": "mdi:package-variant",
                      "iconColor": "#f59e0b"
                    },
                    "gridstack": {"x": 12, "y": 0, "w": 6, "h": 9},
                    "className": "w-[25.00%] h-[260px]",
                    "SA_RUNTIME": {"uiBlockId": "page-main"}
                  }
                }
              }
            },
            {
              "id": "widget-kpi-suppliers",
              "dsl": {
                "id": "kpi-suppliers",
                "name": "DynamicKPICard",
                "type": "KPICard",
                "description": "Total registered suppliers",
                "render": {
                  "id": "render-kpi-suppliers",
                  "type": "COMP_DYNAMICKPICARD",
                  "props": {
                    "query": null,
                    "externalTool": {
                      "toolId": "__PHARMA_TOOL_ID__",
                      "toolName": "__PHARMA_TOOL_NAME__",
                      "parameters": {
                        "sql": "SELECT COUNT(*) as value FROM sc_supplier_master"
                      }
                    },
                    "title": "Total Suppliers",
                    "description": "Total registered suppliers",
                    "config": {
                      "valueKey": "value",
                      "formatNumber": true,
                      "icon": "mdi:domain",
                      "iconColor": "#8b5cf6"
                    },
                    "gridstack": {"x": 18, "y": 0, "w": 6, "h": 9},
                    "className": "w-[25.00%] h-[260px]",
                    "SA_RUNTIME": {"uiBlockId": "page-main"}
                  }
                }
              }
            },
            {
              "id": "widget-pie-po-status",
              "dsl": {
                "id": "pie-po-status",
                "name": "DynamicPieChart",
                "type": "PieChart",
                "description": "Purchase order status breakdown",
                "render": {
                  "id": "render-pie-po-status",
                  "type": "COMP_DYNAMICPIECHART",
                  "props": {
                    "query": null,
                    "externalTool": {
                      "toolId": "__PHARMA_TOOL_ID__",
                      "toolName": "__PHARMA_TOOL_NAME__",
                      "parameters": {
                        "sql": "SELECT status as label, COUNT(*) as value FROM sc_purchase_order_master GROUP BY status ORDER BY value DESC"
                      }
                    },
                    "title": "PO Status Breakdown",
                    "description": "Purchase order status breakdown",
                    "config": {
                      "nameKey": "label",
                      "valueKey": "value"
                    },
                    "gridstack": {"x": 0, "y": 9, "w": 12, "h": 28},
                    "className": "w-[50.00%] h-[830px]",
                    "SA_RUNTIME": {"uiBlockId": "page-main"}
                  }
                }
              }
            },
            {
              "id": "widget-bar-shipment-dest",
              "dsl": {
                "id": "bar-shipment-dest",
                "name": "DynamicBarChart",
                "type": "BarChart",
                "description": "Shipment count by destination country",
                "render": {
                  "id": "render-bar-shipment-dest",
                  "type": "COMP_DYNAMICBARCHART",
                  "props": {
                    "query": null,
                    "externalTool": {
                      "toolId": "__PHARMA_TOOL_ID__",
                      "toolName": "__PHARMA_TOOL_NAME__",
                      "parameters": {
                        "sql": "SELECT destination_country as label, COUNT(*) as value FROM sc_shipment_master GROUP BY destination_country ORDER BY value DESC LIMIT 10"
                      }
                    },
                    "title": "Shipments by Destination",
                    "description": "Shipment count by destination country",
                    "config": {
                      "xAxisKey": "label",
                      "yAxisKey": "value"
                    },
                    "gridstack": {"x": 12, "y": 9, "w": 12, "h": 28},
                    "className": "w-[50.00%] h-[830px]",
                    "SA_RUNTIME": {"uiBlockId": "page-main"}
                  }
                }
              }
            },
            {
              "id": "widget-table-recent-pos",
              "dsl": {
                "id": "table-recent-pos",
                "name": "DynamicDataTable",
                "type": "DataTable",
                "description": "Most recent purchase orders",
                "render": {
                  "id": "render-table-recent-pos",
                  "type": "COMP_DYNAMICDATATABLE",
                  "props": {
                    "query": null,
                    "externalTool": {
                      "toolId": "__PHARMA_TOOL_ID__",
                      "toolName": "__PHARMA_TOOL_NAME__",
                      "parameters": {
                        "sql": "SELECT po_id, supplier_name, total_value, status, order_date FROM sc_purchase_order_master ORDER BY order_date DESC LIMIT 20"
                      }
                    },
                    "title": "Recent Purchase Orders",
                    "description": "Most recent purchase orders",
                    "config": {
                      "title": "Recent Purchase Orders"
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

-- Dashboard 3: Quality & Compliance
INSERT INTO dashboards (dashboard_id, project_id, name, description, dashboard, published, allowed_users)
VALUES (
    'pharma-quality-compliance',
    :project_id,
    'Quality & Compliance',
    'Compliance health at a glance — CAPAs, audit findings, product complaints, and change controls',
    $json${
  "dsl": {
    "id": "dashboard-pharma-quality-compliance",
    "name": "Quality & Compliance",
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
              "id": "widget-kpi-open-capas",
              "dsl": {
                "id": "kpi-open-capas",
                "name": "DynamicKPICard",
                "type": "KPICard",
                "description": "CAPAs not yet closed",
                "render": {
                  "id": "render-kpi-open-capas",
                  "type": "COMP_DYNAMICKPICARD",
                  "props": {
                    "query": null,
                    "externalTool": {
                      "toolId": "__PHARMA_TOOL_ID__",
                      "toolName": "__PHARMA_TOOL_NAME__",
                      "parameters": {
                        "sql": "SELECT COUNT(*) as value FROM comp_capa_master WHERE status NOT IN ('Closed')"
                      }
                    },
                    "title": "Open CAPAs",
                    "description": "CAPAs not yet closed",
                    "config": {
                      "valueKey": "value",
                      "formatNumber": true,
                      "icon": "mdi:clipboard-check",
                      "iconColor": "#ef4444"
                    },
                    "gridstack": {"x": 0, "y": 0, "w": 6, "h": 9},
                    "className": "w-[25.00%] h-[260px]",
                    "SA_RUNTIME": {"uiBlockId": "page-main"}
                  }
                }
              }
            },
            {
              "id": "widget-kpi-audit-findings",
              "dsl": {
                "id": "kpi-audit-findings",
                "name": "DynamicKPICard",
                "type": "KPICard",
                "description": "Total audit findings across all audits",
                "render": {
                  "id": "render-kpi-audit-findings",
                  "type": "COMP_DYNAMICKPICARD",
                  "props": {
                    "query": null,
                    "externalTool": {
                      "toolId": "__PHARMA_TOOL_ID__",
                      "toolName": "__PHARMA_TOOL_NAME__",
                      "parameters": {
                        "sql": "SELECT SUM(findings_critical + findings_major + findings_minor) as value FROM comp_audit_master"
                      }
                    },
                    "title": "Total Audit Findings",
                    "description": "Total audit findings across all audits",
                    "config": {
                      "valueKey": "value",
                      "formatNumber": true,
                      "icon": "mdi:magnify",
                      "iconColor": "#f97316"
                    },
                    "gridstack": {"x": 6, "y": 0, "w": 6, "h": 9},
                    "className": "w-[25.00%] h-[260px]",
                    "SA_RUNTIME": {"uiBlockId": "page-main"}
                  }
                }
              }
            },
            {
              "id": "widget-kpi-open-complaints",
              "dsl": {
                "id": "kpi-open-complaints",
                "name": "DynamicKPICard",
                "type": "KPICard",
                "description": "Product complaints not yet closed",
                "render": {
                  "id": "render-kpi-open-complaints",
                  "type": "COMP_DYNAMICKPICARD",
                  "props": {
                    "query": null,
                    "externalTool": {
                      "toolId": "__PHARMA_TOOL_ID__",
                      "toolName": "__PHARMA_TOOL_NAME__",
                      "parameters": {
                        "sql": "SELECT COUNT(*) as value FROM comp_product_complaints WHERE status != 'Closed'"
                      }
                    },
                    "title": "Open Complaints",
                    "description": "Product complaints not yet closed",
                    "config": {
                      "valueKey": "value",
                      "formatNumber": true,
                      "icon": "mdi:message-alert",
                      "iconColor": "#f59e0b"
                    },
                    "gridstack": {"x": 12, "y": 0, "w": 6, "h": 9},
                    "className": "w-[25.00%] h-[260px]",
                    "SA_RUNTIME": {"uiBlockId": "page-main"}
                  }
                }
              }
            },
            {
              "id": "widget-kpi-change-controls",
              "dsl": {
                "id": "kpi-change-controls",
                "name": "DynamicKPICard",
                "type": "KPICard",
                "description": "Active change controls in progress",
                "render": {
                  "id": "render-kpi-change-controls",
                  "type": "COMP_DYNAMICKPICARD",
                  "props": {
                    "query": null,
                    "externalTool": {
                      "toolId": "__PHARMA_TOOL_ID__",
                      "toolName": "__PHARMA_TOOL_NAME__",
                      "parameters": {
                        "sql": "SELECT COUNT(*) as value FROM comp_change_control WHERE status NOT IN ('Closed', 'Completed')"
                      }
                    },
                    "title": "Active Change Controls",
                    "description": "Active change controls in progress",
                    "config": {
                      "valueKey": "value",
                      "formatNumber": true,
                      "icon": "mdi:swap-horizontal",
                      "iconColor": "#6366f1"
                    },
                    "gridstack": {"x": 18, "y": 0, "w": 6, "h": 9},
                    "className": "w-[25.00%] h-[260px]",
                    "SA_RUNTIME": {"uiBlockId": "page-main"}
                  }
                }
              }
            },
            {
              "id": "widget-pie-capa-risk",
              "dsl": {
                "id": "pie-capa-risk",
                "name": "DynamicPieChart",
                "type": "PieChart",
                "description": "CAPAs grouped by risk level",
                "render": {
                  "id": "render-pie-capa-risk",
                  "type": "COMP_DYNAMICPIECHART",
                  "props": {
                    "query": null,
                    "externalTool": {
                      "toolId": "__PHARMA_TOOL_ID__",
                      "toolName": "__PHARMA_TOOL_NAME__",
                      "parameters": {
                        "sql": "SELECT risk_level as label, COUNT(*) as value FROM comp_capa_master GROUP BY risk_level"
                      }
                    },
                    "title": "CAPAs by Risk Level",
                    "description": "CAPAs grouped by risk level",
                    "config": {
                      "nameKey": "label",
                      "valueKey": "value"
                    },
                    "gridstack": {"x": 0, "y": 9, "w": 12, "h": 28},
                    "className": "w-[50.00%] h-[830px]",
                    "SA_RUNTIME": {"uiBlockId": "page-main"}
                  }
                }
              }
            },
            {
              "id": "widget-bar-complaints-cat",
              "dsl": {
                "id": "bar-complaints-cat",
                "name": "DynamicBarChart",
                "type": "BarChart",
                "description": "Product complaints by category",
                "render": {
                  "id": "render-bar-complaints-cat",
                  "type": "COMP_DYNAMICBARCHART",
                  "props": {
                    "query": null,
                    "externalTool": {
                      "toolId": "__PHARMA_TOOL_ID__",
                      "toolName": "__PHARMA_TOOL_NAME__",
                      "parameters": {
                        "sql": "SELECT category as label, COUNT(*) as value FROM comp_product_complaints GROUP BY category ORDER BY value DESC"
                      }
                    },
                    "title": "Complaints by Category",
                    "description": "Product complaints by category",
                    "config": {
                      "xAxisKey": "label",
                      "yAxisKey": "value"
                    },
                    "gridstack": {"x": 12, "y": 9, "w": 12, "h": 28},
                    "className": "w-[50.00%] h-[830px]",
                    "SA_RUNTIME": {"uiBlockId": "page-main"}
                  }
                }
              }
            },
            {
              "id": "widget-table-audits",
              "dsl": {
                "id": "table-audits",
                "name": "DynamicDataTable",
                "type": "DataTable",
                "description": "Recent audit results",
                "render": {
                  "id": "render-table-audits",
                  "type": "COMP_DYNAMICDATATABLE",
                  "props": {
                    "query": null,
                    "externalTool": {
                      "toolId": "__PHARMA_TOOL_ID__",
                      "toolName": "__PHARMA_TOOL_NAME__",
                      "parameters": {
                        "sql": "SELECT audit_id, facility, audit_type, overall_rating, findings_critical, findings_major, findings_minor, status FROM comp_audit_master ORDER BY audit_start_date DESC LIMIT 20"
                      }
                    },
                    "title": "Recent Audit Results",
                    "description": "Recent audit results",
                    "config": {
                      "title": "Recent Audit Results"
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

-- Dashboard 4: Regulatory & Training
INSERT INTO dashboards (dashboard_id, project_id, name, description, dashboard, published, allowed_users)
VALUES (
    'pharma-regulatory-training',
    :project_id,
    'Regulatory & Training',
    'Regulatory submission pipeline and workforce training compliance overview',
    $json${
  "dsl": {
    "id": "dashboard-pharma-regulatory-training",
    "name": "Regulatory & Training",
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
              "id": "widget-kpi-active-submissions",
              "dsl": {
                "id": "kpi-active-submissions",
                "name": "DynamicKPICard",
                "type": "KPICard",
                "description": "Regulatory submissions in progress",
                "render": {
                  "id": "render-kpi-active-submissions",
                  "type": "COMP_DYNAMICKPICARD",
                  "props": {
                    "query": null,
                    "externalTool": {
                      "toolId": "__PHARMA_TOOL_ID__",
                      "toolName": "__PHARMA_TOOL_NAME__",
                      "parameters": {
                        "sql": "SELECT COUNT(*) as value FROM comp_reg_submissions WHERE status NOT IN ('Approved', 'Withdrawn')"
                      }
                    },
                    "title": "Active Submissions",
                    "description": "Regulatory submissions in progress",
                    "config": {
                      "valueKey": "value",
                      "formatNumber": true,
                      "icon": "mdi:file-document",
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
              "id": "widget-kpi-open-queries",
              "dsl": {
                "id": "kpi-open-queries",
                "name": "DynamicKPICard",
                "type": "KPICard",
                "description": "Open regulatory queries requiring response",
                "render": {
                  "id": "render-kpi-open-queries",
                  "type": "COMP_DYNAMICKPICARD",
                  "props": {
                    "query": null,
                    "externalTool": {
                      "toolId": "__PHARMA_TOOL_ID__",
                      "toolName": "__PHARMA_TOOL_NAME__",
                      "parameters": {
                        "sql": "SELECT COALESCE(SUM(open_queries), 0) as value FROM comp_reg_submissions"
                      }
                    },
                    "title": "Open Queries",
                    "description": "Open regulatory queries requiring response",
                    "config": {
                      "valueKey": "value",
                      "formatNumber": true,
                      "icon": "mdi:help-circle",
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
              "id": "widget-kpi-training-records",
              "dsl": {
                "id": "kpi-training-records",
                "name": "DynamicKPICard",
                "type": "KPICard",
                "description": "Total training records",
                "render": {
                  "id": "render-kpi-training-records",
                  "type": "COMP_DYNAMICKPICARD",
                  "props": {
                    "query": null,
                    "externalTool": {
                      "toolId": "__PHARMA_TOOL_ID__",
                      "toolName": "__PHARMA_TOOL_NAME__",
                      "parameters": {
                        "sql": "SELECT COUNT(*) as value FROM comp_training_records"
                      }
                    },
                    "title": "Training Records",
                    "description": "Total training records",
                    "config": {
                      "valueKey": "value",
                      "formatNumber": true,
                      "icon": "mdi:school",
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
              "id": "widget-kpi-pass-rate",
              "dsl": {
                "id": "kpi-pass-rate",
                "name": "DynamicKPICard",
                "type": "KPICard",
                "description": "Training pass rate",
                "render": {
                  "id": "render-kpi-pass-rate",
                  "type": "COMP_DYNAMICKPICARD",
                  "props": {
                    "query": null,
                    "externalTool": {
                      "toolId": "__PHARMA_TOOL_ID__",
                      "toolName": "__PHARMA_TOOL_NAME__",
                      "parameters": {
                        "sql": "SELECT ROUND(AVG(CASE WHEN passed = 1 THEN 100.0 ELSE 0.0 END)::numeric, 1) as value FROM comp_training_records"
                      }
                    },
                    "title": "Training Pass Rate",
                    "description": "Training pass rate",
                    "config": {
                      "valueKey": "value",
                      "suffix": "%",
                      "formatNumber": true,
                      "icon": "mdi:check-circle",
                      "iconColor": "#f59e0b"
                    },
                    "gridstack": {"x": 18, "y": 0, "w": 6, "h": 9},
                    "className": "w-[25.00%] h-[260px]",
                    "SA_RUNTIME": {"uiBlockId": "page-main"}
                  }
                }
              }
            },
            {
              "id": "widget-pie-submission-status",
              "dsl": {
                "id": "pie-submission-status",
                "name": "DynamicPieChart",
                "type": "PieChart",
                "description": "Regulatory submissions by status",
                "render": {
                  "id": "render-pie-submission-status",
                  "type": "COMP_DYNAMICPIECHART",
                  "props": {
                    "query": null,
                    "externalTool": {
                      "toolId": "__PHARMA_TOOL_ID__",
                      "toolName": "__PHARMA_TOOL_NAME__",
                      "parameters": {
                        "sql": "SELECT status as label, COUNT(*) as value FROM comp_reg_submissions GROUP BY status ORDER BY value DESC"
                      }
                    },
                    "title": "Submissions by Status",
                    "description": "Regulatory submissions by status",
                    "config": {
                      "nameKey": "label",
                      "valueKey": "value"
                    },
                    "gridstack": {"x": 0, "y": 9, "w": 12, "h": 28},
                    "className": "w-[50.00%] h-[830px]",
                    "SA_RUNTIME": {"uiBlockId": "page-main"}
                  }
                }
              }
            },
            {
              "id": "widget-bar-training-dept",
              "dsl": {
                "id": "bar-training-dept",
                "name": "DynamicBarChart",
                "type": "BarChart",
                "description": "Training records by department",
                "render": {
                  "id": "render-bar-training-dept",
                  "type": "COMP_DYNAMICBARCHART",
                  "props": {
                    "query": null,
                    "externalTool": {
                      "toolId": "__PHARMA_TOOL_ID__",
                      "toolName": "__PHARMA_TOOL_NAME__",
                      "parameters": {
                        "sql": "SELECT department as label, COUNT(*) as value FROM comp_training_records GROUP BY department ORDER BY value DESC"
                      }
                    },
                    "title": "Training by Department",
                    "description": "Training records by department",
                    "config": {
                      "xAxisKey": "label",
                      "yAxisKey": "value"
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

-- Dashboard 5: Cost & Risk Analytics
INSERT INTO dashboards (dashboard_id, project_id, name, description, dashboard, published, allowed_users)
VALUES (
    'pharma-cost-risk',
    :project_id,
    'Cost & Risk Analytics',
    'Financial overview of manufacturing costs, material spend, quality costs, and procurement expenditure',
    $json${
  "dsl": {
    "id": "dashboard-pharma-cost-risk",
    "name": "Cost & Risk Analytics",
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
              "id": "widget-kpi-total-batch-cost",
              "dsl": {
                "id": "kpi-total-batch-cost",
                "name": "DynamicKPICard",
                "type": "KPICard",
                "description": "Total manufacturing batch costs",
                "render": {
                  "id": "render-kpi-total-batch-cost",
                  "type": "COMP_DYNAMICKPICARD",
                  "props": {
                    "query": null,
                    "externalTool": {
                      "toolId": "__PHARMA_TOOL_ID__",
                      "toolName": "__PHARMA_TOOL_NAME__",
                      "parameters": {
                        "sql": "SELECT ROUND(SUM(total_cost_usd)::numeric, 0) as value FROM mfg_batch_master"
                      }
                    },
                    "title": "Total Batch Costs",
                    "description": "Total manufacturing batch costs",
                    "config": {
                      "valueKey": "value",
                      "prefix": "$",
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
              "id": "widget-kpi-material-cost",
              "dsl": {
                "id": "kpi-material-cost",
                "name": "DynamicKPICard",
                "type": "KPICard",
                "description": "Total material costs across all batches",
                "render": {
                  "id": "render-kpi-material-cost",
                  "type": "COMP_DYNAMICKPICARD",
                  "props": {
                    "query": null,
                    "externalTool": {
                      "toolId": "__PHARMA_TOOL_ID__",
                      "toolName": "__PHARMA_TOOL_NAME__",
                      "parameters": {
                        "sql": "SELECT ROUND(SUM(material_cost_usd)::numeric, 0) as value FROM mfg_batch_master"
                      }
                    },
                    "title": "Material Costs",
                    "description": "Total material costs across all batches",
                    "config": {
                      "valueKey": "value",
                      "prefix": "$",
                      "formatNumber": true,
                      "icon": "mdi:package-variant-closed",
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
              "id": "widget-kpi-capa-quality-cost",
              "dsl": {
                "id": "kpi-capa-quality-cost",
                "name": "DynamicKPICard",
                "type": "KPICard",
                "description": "Cost of quality from CAPA activities",
                "render": {
                  "id": "render-kpi-capa-quality-cost",
                  "type": "COMP_DYNAMICKPICARD",
                  "props": {
                    "query": null,
                    "externalTool": {
                      "toolId": "__PHARMA_TOOL_ID__",
                      "toolName": "__PHARMA_TOOL_NAME__",
                      "parameters": {
                        "sql": "SELECT ROUND(SUM(cost_of_quality_usd)::numeric, 0) as value FROM comp_capa_master"
                      }
                    },
                    "title": "CAPA Quality Cost",
                    "description": "Cost of quality from CAPA activities",
                    "config": {
                      "valueKey": "value",
                      "prefix": "$",
                      "formatNumber": true,
                      "icon": "mdi:alert-octagon",
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
              "id": "widget-kpi-po-spend",
              "dsl": {
                "id": "kpi-po-spend",
                "name": "DynamicKPICard",
                "type": "KPICard",
                "description": "Total procurement spend",
                "render": {
                  "id": "render-kpi-po-spend",
                  "type": "COMP_DYNAMICKPICARD",
                  "props": {
                    "query": null,
                    "externalTool": {
                      "toolId": "__PHARMA_TOOL_ID__",
                      "toolName": "__PHARMA_TOOL_NAME__",
                      "parameters": {
                        "sql": "SELECT ROUND(SUM(total_value)::numeric, 0) as value FROM sc_purchase_order_master WHERE status NOT IN ('Draft')"
                      }
                    },
                    "title": "Procurement Spend",
                    "description": "Total procurement spend",
                    "config": {
                      "valueKey": "value",
                      "prefix": "$",
                      "formatNumber": true,
                      "icon": "mdi:cash-multiple",
                      "iconColor": "#f59e0b"
                    },
                    "gridstack": {"x": 18, "y": 0, "w": 6, "h": 9},
                    "className": "w-[25.00%] h-[260px]",
                    "SA_RUNTIME": {"uiBlockId": "page-main"}
                  }
                }
              }
            },
            {
              "id": "widget-bar-cost-facility",
              "dsl": {
                "id": "bar-cost-facility",
                "name": "DynamicBarChart",
                "type": "BarChart",
                "description": "Batch manufacturing cost by facility",
                "render": {
                  "id": "render-bar-cost-facility",
                  "type": "COMP_DYNAMICBARCHART",
                  "props": {
                    "query": null,
                    "externalTool": {
                      "toolId": "__PHARMA_TOOL_ID__",
                      "toolName": "__PHARMA_TOOL_NAME__",
                      "parameters": {
                        "sql": "SELECT facility as label, ROUND(SUM(total_cost_usd)::numeric, 0) as value FROM mfg_batch_master GROUP BY facility ORDER BY value DESC"
                      }
                    },
                    "title": "Batch Cost by Facility",
                    "description": "Batch manufacturing cost by facility",
                    "config": {
                      "xAxisKey": "label",
                      "yAxisKey": "value"
                    },
                    "gridstack": {"x": 0, "y": 9, "w": 12, "h": 28},
                    "className": "w-[50.00%] h-[830px]",
                    "SA_RUNTIME": {"uiBlockId": "page-main"}
                  }
                }
              }
            },
            {
              "id": "widget-pie-capa-cost-cat",
              "dsl": {
                "id": "pie-capa-cost-cat",
                "name": "DynamicPieChart",
                "type": "PieChart",
                "description": "CAPA cost of quality by category",
                "render": {
                  "id": "render-pie-capa-cost-cat",
                  "type": "COMP_DYNAMICPIECHART",
                  "props": {
                    "query": null,
                    "externalTool": {
                      "toolId": "__PHARMA_TOOL_ID__",
                      "toolName": "__PHARMA_TOOL_NAME__",
                      "parameters": {
                        "sql": "SELECT category as label, ROUND(SUM(cost_of_quality_usd)::numeric, 0) as value FROM comp_capa_master WHERE cost_of_quality_usd > 0 GROUP BY category"
                      }
                    },
                    "title": "CAPA Cost by Category",
                    "description": "CAPA cost of quality by category",
                    "config": {
                      "nameKey": "label",
                      "valueKey": "value"
                    },
                    "gridstack": {"x": 12, "y": 9, "w": 12, "h": 28},
                    "className": "w-[50.00%] h-[830px]",
                    "SA_RUNTIME": {"uiBlockId": "page-main"}
                  }
                }
              }
            },
            {
              "id": "widget-table-material-costs",
              "dsl": {
                "id": "table-material-costs",
                "name": "DynamicDataTable",
                "type": "DataTable",
                "description": "Top materials by total cost",
                "render": {
                  "id": "render-table-material-costs",
                  "type": "COMP_DYNAMICDATATABLE",
                  "props": {
                    "query": null,
                    "externalTool": {
                      "toolId": "__PHARMA_TOOL_ID__",
                      "toolName": "__PHARMA_TOOL_NAME__",
                      "parameters": {
                        "sql": "SELECT material_name, supplier, SUM(total_cost) as total_cost, COUNT(*) as usage_count FROM mfg_batch_materials GROUP BY material_name, supplier ORDER BY total_cost DESC LIMIT 20"
                      }
                    },
                    "title": "Top Material Costs",
                    "description": "Top materials by total cost",
                    "config": {
                      "title": "Top Material Costs"
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

-- Dashboard 6: Batch Explorer (Interactive Filter)
INSERT INTO dashboards (dashboard_id, project_id, name, description, dashboard, published, allowed_users)
VALUES (
    'pharma-batch-explorer',
    :project_id,
    'Batch Explorer (Interactive)',
    'Interactive dashboard with batch status filter — drill into any status to see yield, costs, and batch details',
    $json${
  "dsl": {
    "id": "dashboard-pharma-batch-explorer",
    "name": "Batch Explorer (Interactive)",
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
              "id": "widget-filter-batch-status",
              "dsl": {
                "id": "filter-batch-status",
                "name": "DynamicFilterDropdown",
                "type": "FilterDropdown",
                "description": "Filter all widgets by batch status",
                "render": {
                  "id": "render-filter-batch-status",
                  "type": "COMP_DYNAMICFILTERDROPDOWN",
                  "props": {
                    "title": "Batch Status",
                    "filterKey": "status",
                    "filters": [
                      {"label": "All Batches", "value": "ALL", "params": {"status_filter": "ALL"}, "isDefault": true},
                      {"label": "Completed", "value": "Completed", "params": {"status_filter": "Completed"}},
                      {"label": "In Progress", "value": "In Progress", "params": {"status_filter": "In Progress"}},
                      {"label": "Failed", "value": "Failed", "params": {"status_filter": "Failed"}},
                      {"label": "On Hold", "value": "On Hold", "params": {"status_filter": "On Hold"}},
                      {"label": "Pending", "value": "Pending", "params": {"status_filter": "Pending"}}
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
              "id": "widget-kpi-filtered-batches",
              "dsl": {
                "id": "kpi-filtered-batches",
                "name": "DynamicKPICard",
                "type": "KPICard",
                "description": "Batch count for selected status",
                "render": {
                  "id": "render-kpi-filtered-batches",
                  "type": "COMP_DYNAMICKPICARD",
                  "props": {
                    "query": null,
                    "externalTool": {
                      "toolId": "__PHARMA_TOOL_ID__",
                      "toolName": "__PHARMA_TOOL_NAME__",
                      "parameters": {
                        "sql": "SELECT COUNT(*) as value FROM mfg_batch_master WHERE (@status_filter = 'ALL' OR status = @status_filter)",
                        "params": {"status_filter": "ALL"}
                      }
                    },
                    "title": "{%statusLabel%} — Batch Count",
                    "description": "{%statusLabel%} batches",
                    "config": {
                      "valueKey": "value",
                      "formatNumber": true,
                      "icon": "mdi:flask",
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
              "id": "widget-kpi-filtered-yield",
              "dsl": {
                "id": "kpi-filtered-yield",
                "name": "DynamicKPICard",
                "type": "KPICard",
                "description": "Average yield for selected status",
                "render": {
                  "id": "render-kpi-filtered-yield",
                  "type": "COMP_DYNAMICKPICARD",
                  "props": {
                    "query": null,
                    "externalTool": {
                      "toolId": "__PHARMA_TOOL_ID__",
                      "toolName": "__PHARMA_TOOL_NAME__",
                      "parameters": {
                        "sql": "SELECT ROUND(AVG(yield_percent)::numeric, 1) as value FROM mfg_batch_master WHERE yield_percent IS NOT NULL AND (@status_filter = 'ALL' OR status = @status_filter)",
                        "params": {"status_filter": "ALL"}
                      }
                    },
                    "title": "{%statusLabel%} — Avg Yield",
                    "description": "Average yield for {%statusLabel%} batches",
                    "config": {
                      "valueKey": "value",
                      "suffix": "%",
                      "formatNumber": true,
                      "icon": "mdi:chart-line",
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
              "id": "widget-kpi-filtered-total-cost",
              "dsl": {
                "id": "kpi-filtered-total-cost",
                "name": "DynamicKPICard",
                "type": "KPICard",
                "description": "Total batch cost for selected status",
                "render": {
                  "id": "render-kpi-filtered-total-cost",
                  "type": "COMP_DYNAMICKPICARD",
                  "props": {
                    "query": null,
                    "externalTool": {
                      "toolId": "__PHARMA_TOOL_ID__",
                      "toolName": "__PHARMA_TOOL_NAME__",
                      "parameters": {
                        "sql": "SELECT ROUND(SUM(total_cost_usd)::numeric, 0) as value FROM mfg_batch_master WHERE (@status_filter = 'ALL' OR status = @status_filter)",
                        "params": {"status_filter": "ALL"}
                      }
                    },
                    "title": "{%statusLabel%} — Total Cost",
                    "description": "Cumulative cost for {%statusLabel%}",
                    "config": {
                      "valueKey": "value",
                      "prefix": "$",
                      "formatNumber": true,
                      "icon": "mdi:currency-usd",
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
              "id": "widget-chart-filtered-facility",
              "dsl": {
                "id": "chart-filtered-facility",
                "name": "DynamicBarChart",
                "type": "BarChart",
                "description": "Batch count by facility for selected status",
                "render": {
                  "id": "render-chart-filtered-facility",
                  "type": "COMP_DYNAMICBARCHART",
                  "props": {
                    "query": null,
                    "externalTool": {
                      "toolId": "__PHARMA_TOOL_ID__",
                      "toolName": "__PHARMA_TOOL_NAME__",
                      "parameters": {
                        "sql": "SELECT facility as label, COUNT(*) as value FROM mfg_batch_master WHERE (@status_filter = 'ALL' OR status = @status_filter) GROUP BY facility ORDER BY value DESC",
                        "params": {"status_filter": "ALL"}
                      }
                    },
                    "title": "{%statusLabel%} — Batches by Facility",
                    "description": "Production volume for {%statusLabel%}",
                    "config": {
                      "xAxisKey": "label",
                      "yAxisKey": "value",
                      "xAxisLabel": "Facility",
                      "yAxisLabel": "Batch Count",
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
              "id": "widget-chart-filtered-yield-product",
              "dsl": {
                "id": "chart-filtered-yield-product",
                "name": "DynamicBarChart",
                "type": "BarChart",
                "description": "Average yield by product type for selected status",
                "render": {
                  "id": "render-chart-filtered-yield-product",
                  "type": "COMP_DYNAMICBARCHART",
                  "props": {
                    "query": null,
                    "externalTool": {
                      "toolId": "__PHARMA_TOOL_ID__",
                      "toolName": "__PHARMA_TOOL_NAME__",
                      "parameters": {
                        "sql": "SELECT product_type as label, ROUND(AVG(yield_percent)::numeric, 1) as value FROM mfg_batch_master WHERE yield_percent IS NOT NULL AND (@status_filter = 'ALL' OR status = @status_filter) GROUP BY product_type ORDER BY value DESC",
                        "params": {"status_filter": "ALL"}
                      }
                    },
                    "title": "{%statusLabel%} — Avg Yield by Product Type",
                    "description": "Yield efficiency for {%statusLabel%} batches",
                    "config": {
                      "xAxisKey": "label",
                      "yAxisKey": "value",
                      "xAxisLabel": "Product Type",
                      "yAxisLabel": "Avg Yield (%)",
                      "height": 400,
                      "orientation": "vertical",
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
              "id": "widget-table-filtered-batches",
              "dsl": {
                "id": "table-filtered-batches",
                "name": "DynamicDataTable",
                "type": "DataTable",
                "description": "Batch details for selected status",
                "render": {
                  "id": "render-table-filtered-batches",
                  "type": "COMP_DYNAMICDATATABLE",
                  "props": {
                    "query": null,
                    "externalTool": {
                      "toolId": "__PHARMA_TOOL_ID__",
                      "toolName": "__PHARMA_TOOL_NAME__",
                      "parameters": {
                        "sql": "SELECT batch_id, product_name, product_type, facility, status, ROUND(yield_percent::numeric, 1) as yield_pct, ROUND(total_cost_usd::numeric, 0) as total_cost_usd, start_date FROM mfg_batch_master WHERE (@status_filter = 'ALL' OR status = @status_filter) ORDER BY start_date DESC LIMIT 20",
                        "params": {"status_filter": "ALL"}
                      }
                    },
                    "title": "{%statusLabel%} — Batch Details",
                    "description": "Recent {%statusLabel%} batches",
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
