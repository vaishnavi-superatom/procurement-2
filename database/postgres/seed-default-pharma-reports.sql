-- =============================================================================
-- Default Reports for Pharma Dataset
-- Seeded during setup for CIO/CTO demo experience
-- Uses :project_id psql variable for project association
-- =============================================================================

-- Clean up existing default pharma reports for this project (idempotent)
DELETE FROM reports WHERE report_id IN (
    'pharma-batch-mfg-summary',
    'pharma-supply-chain-health',
    'pharma-compliance-audit',
    'pharma-regulatory-status',
    'pharma-supplier-quality'
) AND project_id = :project_id;

-- Report 1: Batch Manufacturing Summary
INSERT INTO reports (report_id, project_id, name, description, report, published)
VALUES (
    'pharma-batch-mfg-summary',
    :project_id,
    'Batch Manufacturing Summary',
    'Executive overview of batch manufacturing performance — production volume, yield efficiency, and deviation analysis',
    $json${
  "dsl": {
    "id": "pharma-batch-mfg-summary",
    "name": "Batch Manufacturing Summary",
    "render": {
      "id": "root",
      "type": "MultiComponentContainer",
      "props": {
        "config": {
          "layout": "vertical",
          "components": [
            {
              "id": "md-mfg-header",
              "type": "MarkdownBlock",
              "name": "DynamicMarkdownBlock",
              "props": {
                "content": "# Batch Manufacturing Summary\n\n**Prepared by:** Manufacturing Operations Team\n\n---\n\n## Executive Summary\n\nThis report provides a comprehensive overview of batch manufacturing performance across all facilities. Key metrics including total production volume, yield efficiency, deviation rates, and batch hold status are analyzed to ensure operational excellence and regulatory compliance.\n\n> **Key Takeaway:** Monitoring batch yield and deviation trends is critical for maintaining product quality and identifying process improvement opportunities."
              }
            },
            {
              "id": "kpi-total-batches",
              "type": "KPICard",
              "name": "DynamicKPICard",
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
                "description": "Total manufacturing batches produced",
                "config": {
                  "valueKey": "value",
                  "formatNumber": true,
                  "icon": "mdi:flask",
                  "iconColor": "#6366f1"
                }
              }
            },
            {
              "id": "kpi-avg-yield",
              "type": "KPICard",
              "name": "DynamicKPICard",
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
                "description": "Average batch yield across all products",
                "config": {
                  "valueKey": "value",
                  "suffix": "%",
                  "formatNumber": true,
                  "icon": "mdi:chart-line",
                  "iconColor": "#22c55e"
                }
              }
            },
            {
              "id": "kpi-total-deviations",
              "type": "KPICard",
              "name": "DynamicKPICard",
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
                "description": "All batch deviations recorded",
                "config": {
                  "valueKey": "value",
                  "formatNumber": true,
                  "icon": "mdi:alert-circle",
                  "iconColor": "#ef4444"
                }
              }
            },
            {
              "id": "kpi-batches-on-hold",
              "type": "KPICard",
              "name": "DynamicKPICard",
              "props": {
                "query": null,
                "externalTool": {
                  "toolId": "__PHARMA_TOOL_ID__",
                  "toolName": "__PHARMA_TOOL_NAME__",
                  "parameters": {
                    "sql": "SELECT COUNT(*) as value FROM mfg_batch_master WHERE status = 'On Hold'"
                  }
                },
                "title": "Batches On Hold",
                "description": "Batches currently on hold",
                "config": {
                  "valueKey": "value",
                  "formatNumber": true,
                  "icon": "mdi:pause-circle",
                  "iconColor": "#f59e0b"
                }
              }
            },
            {
              "id": "md-mfg-facility-section",
              "type": "MarkdownBlock",
              "name": "DynamicMarkdownBlock",
              "props": {
                "content": "---\n\n## Facility Performance\n\nThe chart below breaks down batch production status across manufacturing facilities. This helps identify which facilities are operating efficiently and which may require additional attention."
              }
            },
            {
              "id": "bar-batch-facility",
              "type": "BarChart",
              "name": "DynamicBarChart",
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
                "description": "Batch production status across manufacturing facilities",
                "config": {
                  "xAxisKey": "label",
                  "yAxisKey": "value",
                  "categoryKey": "category"
                }
              }
            },
            {
              "id": "md-mfg-deviation-section",
              "type": "MarkdownBlock",
              "name": "DynamicMarkdownBlock",
              "props": {
                "content": "## Deviation Analysis\n\nUnderstanding the severity distribution of batch deviations is essential for prioritizing corrective actions and maintaining GMP compliance."
              }
            },
            {
              "id": "pie-deviation-severity",
              "type": "PieChart",
              "name": "DynamicPieChart",
              "props": {
                "query": null,
                "externalTool": {
                  "toolId": "__PHARMA_TOOL_ID__",
                  "toolName": "__PHARMA_TOOL_NAME__",
                  "parameters": {
                    "sql": "SELECT severity as label, COUNT(*) as value FROM mfg_batch_deviations GROUP BY severity ORDER BY value DESC"
                  }
                },
                "title": "Deviations by Severity",
                "description": "Distribution of deviations by severity level",
                "config": {
                  "nameKey": "label",
                  "valueKey": "value"
                }
              }
            },
            {
              "id": "md-mfg-deviations-table-section",
              "type": "MarkdownBlock",
              "name": "DynamicMarkdownBlock",
              "props": {
                "content": "---\n\n## Recent Deviations\n\nThe table below lists the most recently reported batch deviations, providing visibility into active quality events that may require investigation or escalation."
              }
            },
            {
              "id": "table-recent-deviations",
              "type": "DataTable",
              "name": "DynamicDataTable",
              "props": {
                "query": null,
                "externalTool": {
                  "toolId": "__PHARMA_TOOL_ID__",
                  "toolName": "__PHARMA_TOOL_NAME__",
                  "parameters": {
                    "sql": "SELECT deviation_id, batch_id, severity, category, deviation_type, status, facility FROM mfg_batch_deviations ORDER BY reported_date DESC LIMIT 20"
                  }
                },
                "title": "Recent Deviations",
                "description": "Most recently reported batch deviations",
                "config": {
                  "title": "Recent Deviations"
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

-- Report 2: Supply Chain Health Report
INSERT INTO reports (report_id, project_id, name, description, report, published)
VALUES (
    'pharma-supply-chain-health',
    :project_id,
    'Supply Chain Health Report',
    'Comprehensive supply chain analysis — procurement activity, inventory levels, and logistics performance',
    $json${
  "dsl": {
    "id": "pharma-supply-chain-health",
    "name": "Supply Chain Health Report",
    "render": {
      "id": "root",
      "type": "MultiComponentContainer",
      "props": {
        "config": {
          "layout": "vertical",
          "components": [
            {
              "id": "md-sc-header",
              "type": "MarkdownBlock",
              "name": "DynamicMarkdownBlock",
              "props": {
                "content": "# Supply Chain Health Report\n\n**Prepared by:** Supply Chain Operations Team\n\n---\n\n## Executive Summary\n\nThis report provides a holistic view of supply chain operations including procurement activity, warehouse inventory levels, and shipment logistics. Monitoring these metrics ensures continuity of supply and highlights areas requiring intervention.\n\n> **Key Takeaway:** A healthy supply chain balances procurement velocity with inventory optimization and on-time delivery performance."
              }
            },
            {
              "id": "kpi-po-total-value",
              "type": "KPICard",
              "name": "DynamicKPICard",
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
                "description": "Total value of all purchase orders",
                "config": {
                  "valueKey": "value",
                  "prefix": "$",
                  "formatNumber": true,
                  "icon": "mdi:cart",
                  "iconColor": "#6366f1"
                }
              }
            },
            {
              "id": "kpi-delivered-shipments",
              "type": "KPICard",
              "name": "DynamicKPICard",
              "props": {
                "query": null,
                "externalTool": {
                  "toolId": "__PHARMA_TOOL_ID__",
                  "toolName": "__PHARMA_TOOL_NAME__",
                  "parameters": {
                    "sql": "SELECT COUNT(*) as value FROM sc_shipment_master WHERE status = 'Delivered'"
                  }
                },
                "title": "Delivered Shipments",
                "description": "Successfully delivered shipments",
                "config": {
                  "valueKey": "value",
                  "formatNumber": true,
                  "icon": "mdi:truck-check",
                  "iconColor": "#22c55e"
                }
              }
            },
            {
              "id": "kpi-inventory-value",
              "type": "KPICard",
              "name": "DynamicKPICard",
              "props": {
                "query": null,
                "externalTool": {
                  "toolId": "__PHARMA_TOOL_ID__",
                  "toolName": "__PHARMA_TOOL_NAME__",
                  "parameters": {
                    "sql": "SELECT ROUND(SUM(value_usd)::numeric, 0) as value FROM sc_inventory_master"
                  }
                },
                "title": "Inventory Value",
                "description": "Total inventory value across all warehouses",
                "config": {
                  "valueKey": "value",
                  "prefix": "$",
                  "formatNumber": true,
                  "icon": "mdi:package-variant",
                  "iconColor": "#f59e0b"
                }
              }
            },
            {
              "id": "kpi-warehouses",
              "type": "KPICard",
              "name": "DynamicKPICard",
              "props": {
                "query": null,
                "externalTool": {
                  "toolId": "__PHARMA_TOOL_ID__",
                  "toolName": "__PHARMA_TOOL_NAME__",
                  "parameters": {
                    "sql": "SELECT COUNT(*) as value FROM sc_warehouse_master"
                  }
                },
                "title": "Warehouses",
                "description": "Total number of warehouses",
                "config": {
                  "valueKey": "value",
                  "formatNumber": true,
                  "icon": "mdi:warehouse",
                  "iconColor": "#8b5cf6"
                }
              }
            },
            {
              "id": "md-sc-procurement-section",
              "type": "MarkdownBlock",
              "name": "DynamicMarkdownBlock",
              "props": {
                "content": "---\n\n## Procurement Overview\n\nThe following visualizations show the current state of purchase orders and inventory distribution across warehouses. This helps identify procurement bottlenecks and inventory imbalances."
              }
            },
            {
              "id": "pie-po-status",
              "type": "PieChart",
              "name": "DynamicPieChart",
              "props": {
                "query": null,
                "externalTool": {
                  "toolId": "__PHARMA_TOOL_ID__",
                  "toolName": "__PHARMA_TOOL_NAME__",
                  "parameters": {
                    "sql": "SELECT status as label, COUNT(*) as value FROM sc_purchase_order_master GROUP BY status ORDER BY value DESC"
                  }
                },
                "title": "Purchase Orders by Status",
                "description": "Distribution of purchase orders by current status",
                "config": {
                  "nameKey": "label",
                  "valueKey": "value"
                }
              }
            },
            {
              "id": "bar-inventory-warehouse",
              "type": "BarChart",
              "name": "DynamicBarChart",
              "props": {
                "query": null,
                "externalTool": {
                  "toolId": "__PHARMA_TOOL_ID__",
                  "toolName": "__PHARMA_TOOL_NAME__",
                  "parameters": {
                    "sql": "SELECT w.warehouse_name as label, COUNT(i.inventory_id) as value FROM sc_warehouse_master w LEFT JOIN sc_inventory_master i ON w.warehouse_id = i.warehouse_id GROUP BY w.warehouse_name ORDER BY value DESC"
                  }
                },
                "title": "Inventory Items by Warehouse",
                "description": "Number of inventory items per warehouse",
                "config": {
                  "xAxisKey": "label",
                  "yAxisKey": "value"
                }
              }
            },
            {
              "id": "md-sc-logistics-section",
              "type": "MarkdownBlock",
              "name": "DynamicMarkdownBlock",
              "props": {
                "content": "## Logistics & Shipment Status\n\nShipment tracking provides real-time visibility into the logistics pipeline. The distribution below highlights the current status of all shipments across the network."
              }
            },
            {
              "id": "pie-shipment-status",
              "type": "PieChart",
              "name": "DynamicPieChart",
              "props": {
                "query": null,
                "externalTool": {
                  "toolId": "__PHARMA_TOOL_ID__",
                  "toolName": "__PHARMA_TOOL_NAME__",
                  "parameters": {
                    "sql": "SELECT status as label, COUNT(*) as value FROM sc_shipment_master GROUP BY status ORDER BY value DESC"
                  }
                },
                "title": "Shipment Status",
                "description": "Current status of all shipments",
                "config": {
                  "nameKey": "label",
                  "valueKey": "value"
                }
              }
            },
            {
              "id": "md-sc-orders-section",
              "type": "MarkdownBlock",
              "name": "DynamicMarkdownBlock",
              "props": {
                "content": "---\n\n## Recent Purchase Orders\n\nThe table below lists the most recent purchase orders with key details including supplier, value, status, and priority level."
              }
            },
            {
              "id": "table-recent-pos",
              "type": "DataTable",
              "name": "DynamicDataTable",
              "props": {
                "query": null,
                "externalTool": {
                  "toolId": "__PHARMA_TOOL_ID__",
                  "toolName": "__PHARMA_TOOL_NAME__",
                  "parameters": {
                    "sql": "SELECT po_id, supplier_name, total_value, status, order_date, priority FROM sc_purchase_order_master ORDER BY order_date DESC LIMIT 20"
                  }
                },
                "title": "Recent Purchase Orders",
                "description": "Most recent purchase orders with details",
                "config": {
                  "title": "Recent Purchase Orders"
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

-- Report 3: Compliance & Audit Report
INSERT INTO reports (report_id, project_id, name, description, report, published)
VALUES (
    'pharma-compliance-audit',
    :project_id,
    'Compliance & Audit Report',
    'Compliance health assessment — audit results, CAPA effectiveness, complaint trends, and corrective actions',
    $json${
  "dsl": {
    "id": "pharma-compliance-audit",
    "name": "Compliance & Audit Report",
    "render": {
      "id": "root",
      "type": "MultiComponentContainer",
      "props": {
        "config": {
          "layout": "vertical",
          "components": [
            {
              "id": "md-compliance-header",
              "type": "MarkdownBlock",
              "name": "DynamicMarkdownBlock",
              "props": {
                "content": "# Compliance & Audit Report\n\n**Prepared by:** Quality Assurance & Compliance Team\n\n---\n\n## Executive Summary\n\nThis report provides a comprehensive assessment of compliance health across the organization. It covers audit outcomes, CAPA (Corrective and Preventive Action) effectiveness, and product complaint trends to ensure adherence to regulatory standards and continuous quality improvement.\n\n> **Key Takeaway:** Proactive monitoring of audit findings, CAPA closure rates, and complaint severity is essential for maintaining regulatory readiness and minimizing risk."
              }
            },
            {
              "id": "kpi-total-audits",
              "type": "KPICard",
              "name": "DynamicKPICard",
              "props": {
                "query": null,
                "externalTool": {
                  "toolId": "__PHARMA_TOOL_ID__",
                  "toolName": "__PHARMA_TOOL_NAME__",
                  "parameters": {
                    "sql": "SELECT COUNT(*) as value FROM comp_audit_master"
                  }
                },
                "title": "Total Audits",
                "description": "Total audits conducted",
                "config": {
                  "valueKey": "value",
                  "formatNumber": true,
                  "icon": "mdi:clipboard-search",
                  "iconColor": "#6366f1"
                }
              }
            },
            {
              "id": "kpi-critical-findings",
              "type": "KPICard",
              "name": "DynamicKPICard",
              "props": {
                "query": null,
                "externalTool": {
                  "toolId": "__PHARMA_TOOL_ID__",
                  "toolName": "__PHARMA_TOOL_NAME__",
                  "parameters": {
                    "sql": "SELECT COALESCE(SUM(findings_critical), 0) as value FROM comp_audit_master"
                  }
                },
                "title": "Critical Findings",
                "description": "Total critical audit findings",
                "config": {
                  "valueKey": "value",
                  "formatNumber": true,
                  "icon": "mdi:alert-octagon",
                  "iconColor": "#ef4444"
                }
              }
            },
            {
              "id": "kpi-open-capas",
              "type": "KPICard",
              "name": "DynamicKPICard",
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
                  "iconColor": "#f97316"
                }
              }
            },
            {
              "id": "kpi-open-complaints",
              "type": "KPICard",
              "name": "DynamicKPICard",
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
                "description": "Product complaints not yet resolved",
                "config": {
                  "valueKey": "value",
                  "formatNumber": true,
                  "icon": "mdi:message-alert",
                  "iconColor": "#f59e0b"
                }
              }
            },
            {
              "id": "md-compliance-audit-section",
              "type": "MarkdownBlock",
              "name": "DynamicMarkdownBlock",
              "props": {
                "content": "---\n\n## Audit Performance\n\nThe following visualizations provide insight into overall audit outcomes and CAPA status. Audit ratings indicate the health of quality systems, while CAPA tracking ensures corrective actions are being resolved in a timely manner."
              }
            },
            {
              "id": "pie-audit-rating",
              "type": "PieChart",
              "name": "DynamicPieChart",
              "props": {
                "query": null,
                "externalTool": {
                  "toolId": "__PHARMA_TOOL_ID__",
                  "toolName": "__PHARMA_TOOL_NAME__",
                  "parameters": {
                    "sql": "SELECT overall_rating as label, COUNT(*) as value FROM comp_audit_master WHERE overall_rating IS NOT NULL GROUP BY overall_rating ORDER BY value DESC"
                  }
                },
                "title": "Audits by Overall Rating",
                "description": "Distribution of audit outcomes by rating",
                "config": {
                  "nameKey": "label",
                  "valueKey": "value"
                }
              }
            },
            {
              "id": "bar-capa-status",
              "type": "BarChart",
              "name": "DynamicBarChart",
              "props": {
                "query": null,
                "externalTool": {
                  "toolId": "__PHARMA_TOOL_ID__",
                  "toolName": "__PHARMA_TOOL_NAME__",
                  "parameters": {
                    "sql": "SELECT status as label, COUNT(*) as value FROM comp_capa_master GROUP BY status ORDER BY value DESC"
                  }
                },
                "title": "CAPA Status Distribution",
                "description": "CAPAs grouped by current status",
                "config": {
                  "xAxisKey": "label",
                  "yAxisKey": "value"
                }
              }
            },
            {
              "id": "md-compliance-complaints-section",
              "type": "MarkdownBlock",
              "name": "DynamicMarkdownBlock",
              "props": {
                "content": "## Product Complaint Analysis\n\nProduct complaints are a key indicator of quality performance. The severity distribution below helps prioritize investigation efforts and resource allocation."
              }
            },
            {
              "id": "pie-complaint-severity",
              "type": "PieChart",
              "name": "DynamicPieChart",
              "props": {
                "query": null,
                "externalTool": {
                  "toolId": "__PHARMA_TOOL_ID__",
                  "toolName": "__PHARMA_TOOL_NAME__",
                  "parameters": {
                    "sql": "SELECT severity as label, COUNT(*) as value FROM comp_product_complaints GROUP BY severity ORDER BY value DESC"
                  }
                },
                "title": "Complaints by Severity",
                "description": "Product complaint distribution by severity",
                "config": {
                  "nameKey": "label",
                  "valueKey": "value"
                }
              }
            },
            {
              "id": "md-compliance-findings-section",
              "type": "MarkdownBlock",
              "name": "DynamicMarkdownBlock",
              "props": {
                "content": "---\n\n## Open Audit Findings\n\nThe table below lists audit findings that remain open and require resolution. These items should be prioritized based on severity to maintain compliance posture."
              }
            },
            {
              "id": "table-open-findings",
              "type": "DataTable",
              "name": "DynamicDataTable",
              "props": {
                "query": null,
                "externalTool": {
                  "toolId": "__PHARMA_TOOL_ID__",
                  "toolName": "__PHARMA_TOOL_NAME__",
                  "parameters": {
                    "sql": "SELECT af.finding_id, am.facility, af.category, af.severity, af.finding_title, af.status FROM comp_audit_findings af JOIN comp_audit_master am ON af.audit_id = am.audit_id WHERE af.status != 'Closed' ORDER BY af.severity LIMIT 20"
                  }
                },
                "title": "Open Audit Findings",
                "description": "Audit findings still requiring resolution",
                "config": {
                  "title": "Open Audit Findings"
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

-- Report 4: Regulatory Submissions Status
INSERT INTO reports (report_id, project_id, name, description, report, published)
VALUES (
    'pharma-regulatory-status',
    :project_id,
    'Regulatory Submissions Status',
    'Regulatory submission pipeline — application status, query management, and approval tracking',
    $json${
  "dsl": {
    "id": "pharma-regulatory-status",
    "name": "Regulatory Submissions Status",
    "render": {
      "id": "root",
      "type": "MultiComponentContainer",
      "props": {
        "config": {
          "layout": "vertical",
          "components": [
            {
              "id": "md-reg-header",
              "type": "MarkdownBlock",
              "name": "DynamicMarkdownBlock",
              "props": {
                "content": "# Regulatory Submissions Status\n\n**Prepared by:** Regulatory Affairs Team\n\n---\n\n## Executive Summary\n\nThis report tracks the status of all regulatory submissions across global markets. It provides visibility into the approval pipeline, open regulatory queries, and associated fees to ensure timely market access for pharmaceutical products.\n\n> **Key Takeaway:** Timely resolution of regulatory queries and proactive submission tracking are critical to avoiding delays in product approvals and market launches."
              }
            },
            {
              "id": "kpi-total-submissions",
              "type": "KPICard",
              "name": "DynamicKPICard",
              "props": {
                "query": null,
                "externalTool": {
                  "toolId": "__PHARMA_TOOL_ID__",
                  "toolName": "__PHARMA_TOOL_NAME__",
                  "parameters": {
                    "sql": "SELECT COUNT(*) as value FROM comp_reg_submissions"
                  }
                },
                "title": "Total Submissions",
                "description": "All regulatory submissions",
                "config": {
                  "valueKey": "value",
                  "formatNumber": true,
                  "icon": "mdi:file-document",
                  "iconColor": "#6366f1"
                }
              }
            },
            {
              "id": "kpi-approved",
              "type": "KPICard",
              "name": "DynamicKPICard",
              "props": {
                "query": null,
                "externalTool": {
                  "toolId": "__PHARMA_TOOL_ID__",
                  "toolName": "__PHARMA_TOOL_NAME__",
                  "parameters": {
                    "sql": "SELECT COUNT(*) as value FROM comp_reg_submissions WHERE status = 'Approved'"
                  }
                },
                "title": "Approved",
                "description": "Submissions with approval",
                "config": {
                  "valueKey": "value",
                  "formatNumber": true,
                  "icon": "mdi:check-decagram",
                  "iconColor": "#22c55e"
                }
              }
            },
            {
              "id": "kpi-open-queries",
              "type": "KPICard",
              "name": "DynamicKPICard",
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
                "description": "Regulatory queries pending response",
                "config": {
                  "valueKey": "value",
                  "formatNumber": true,
                  "icon": "mdi:help-circle",
                  "iconColor": "#ef4444"
                }
              }
            },
            {
              "id": "kpi-fees-paid",
              "type": "KPICard",
              "name": "DynamicKPICard",
              "props": {
                "query": null,
                "externalTool": {
                  "toolId": "__PHARMA_TOOL_ID__",
                  "toolName": "__PHARMA_TOOL_NAME__",
                  "parameters": {
                    "sql": "SELECT ROUND(SUM(fees_paid_usd)::numeric, 0) as value FROM comp_reg_submissions"
                  }
                },
                "title": "Total Fees Paid",
                "description": "Regulatory fees paid to date",
                "config": {
                  "valueKey": "value",
                  "prefix": "$",
                  "formatNumber": true,
                  "icon": "mdi:cash",
                  "iconColor": "#f59e0b"
                }
              }
            },
            {
              "id": "md-reg-pipeline-section",
              "type": "MarkdownBlock",
              "name": "DynamicMarkdownBlock",
              "props": {
                "content": "---\n\n## Submission Pipeline\n\nThe visualizations below show the geographic distribution of submissions and their current status breakdown. This helps identify regional bottlenecks and prioritize follow-up actions."
              }
            },
            {
              "id": "bar-submissions-region",
              "type": "BarChart",
              "name": "DynamicBarChart",
              "props": {
                "query": null,
                "externalTool": {
                  "toolId": "__PHARMA_TOOL_ID__",
                  "toolName": "__PHARMA_TOOL_NAME__",
                  "parameters": {
                    "sql": "SELECT region as label, COUNT(*) as value FROM comp_reg_submissions GROUP BY region ORDER BY value DESC"
                  }
                },
                "title": "Submissions by Region",
                "description": "Regulatory submissions grouped by geographic region",
                "config": {
                  "xAxisKey": "label",
                  "yAxisKey": "value"
                }
              }
            },
            {
              "id": "pie-submission-status",
              "type": "PieChart",
              "name": "DynamicPieChart",
              "props": {
                "query": null,
                "externalTool": {
                  "toolId": "__PHARMA_TOOL_ID__",
                  "toolName": "__PHARMA_TOOL_NAME__",
                  "parameters": {
                    "sql": "SELECT status as label, COUNT(*) as value FROM comp_reg_submissions GROUP BY status ORDER BY value DESC"
                  }
                },
                "title": "Submission Status Breakdown",
                "description": "Current status distribution of all submissions",
                "config": {
                  "nameKey": "label",
                  "valueKey": "value"
                }
              }
            },
            {
              "id": "md-reg-queries-section",
              "type": "MarkdownBlock",
              "name": "DynamicMarkdownBlock",
              "props": {
                "content": "## Regulatory Queries\n\nRegulatory queries represent requests for additional information from health authorities. Tracking query types helps identify common documentation gaps and improve future submission quality."
              }
            },
            {
              "id": "bar-queries-type",
              "type": "BarChart",
              "name": "DynamicBarChart",
              "props": {
                "query": null,
                "externalTool": {
                  "toolId": "__PHARMA_TOOL_ID__",
                  "toolName": "__PHARMA_TOOL_NAME__",
                  "parameters": {
                    "sql": "SELECT query_type as label, COUNT(*) as value FROM comp_reg_queries GROUP BY query_type ORDER BY value DESC"
                  }
                },
                "title": "Regulatory Queries by Type",
                "description": "Types of regulatory queries received",
                "config": {
                  "xAxisKey": "label",
                  "yAxisKey": "value"
                }
              }
            },
            {
              "id": "md-reg-active-section",
              "type": "MarkdownBlock",
              "name": "DynamicMarkdownBlock",
              "props": {
                "content": "---\n\n## Active Submissions\n\nThe table below lists submissions currently in review or pending approval. These require ongoing monitoring to ensure timely responses to regulatory authority requests."
              }
            },
            {
              "id": "table-active-submissions",
              "type": "DataTable",
              "name": "DynamicDataTable",
              "props": {
                "query": null,
                "externalTool": {
                  "toolId": "__PHARMA_TOOL_ID__",
                  "toolName": "__PHARMA_TOOL_NAME__",
                  "parameters": {
                    "sql": "SELECT submission_id, product_name, submission_type, regulatory_body, region, status, open_queries, submission_date FROM comp_reg_submissions WHERE status NOT IN ('Approved', 'Withdrawn') ORDER BY submission_date DESC LIMIT 20"
                  }
                },
                "title": "Active Submissions",
                "description": "Submissions currently in review or pending",
                "config": {
                  "title": "Active Submissions"
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

-- Report 5: Supplier Quality & Risk Report
INSERT INTO reports (report_id, project_id, name, description, report, published)
VALUES (
    'pharma-supplier-quality',
    :project_id,
    'Supplier Quality & Risk Report',
    'Supplier management overview — qualification status, quality ratings, contract coverage, and risk assessment',
    $json${
  "dsl": {
    "id": "pharma-supplier-quality",
    "name": "Supplier Quality & Risk Report",
    "render": {
      "id": "root",
      "type": "MultiComponentContainer",
      "props": {
        "config": {
          "layout": "vertical",
          "components": [
            {
              "id": "md-supplier-header",
              "type": "MarkdownBlock",
              "name": "DynamicMarkdownBlock",
              "props": {
                "content": "# Supplier Quality & Risk Report\n\n**Prepared by:** Supplier Quality Management Team\n\n---\n\n## Executive Summary\n\nThis report evaluates supplier performance across quality, risk, and contract dimensions. Effective supplier management is critical to ensuring consistent material quality, regulatory compliance, and supply continuity in pharmaceutical manufacturing.\n\n> **Key Takeaway:** Supplier risk stratification combined with quality rating trends enables proactive management of the supplier base and early identification of potential supply disruptions."
              }
            },
            {
              "id": "kpi-total-suppliers",
              "type": "KPICard",
              "name": "DynamicKPICard",
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
                "description": "Registered suppliers in the system",
                "config": {
                  "valueKey": "value",
                  "formatNumber": true,
                  "icon": "mdi:domain",
                  "iconColor": "#6366f1"
                }
              }
            },
            {
              "id": "kpi-avg-quality",
              "type": "KPICard",
              "name": "DynamicKPICard",
              "props": {
                "query": null,
                "externalTool": {
                  "toolId": "__PHARMA_TOOL_ID__",
                  "toolName": "__PHARMA_TOOL_NAME__",
                  "parameters": {
                    "sql": "SELECT ROUND(AVG(quality_rating)::numeric, 1) as value FROM sc_supplier_master WHERE quality_rating IS NOT NULL"
                  }
                },
                "title": "Avg Quality Rating",
                "description": "Average supplier quality rating",
                "config": {
                  "valueKey": "value",
                  "formatNumber": true,
                  "icon": "mdi:star",
                  "iconColor": "#22c55e"
                }
              }
            },
            {
              "id": "kpi-active-contracts",
              "type": "KPICard",
              "name": "DynamicKPICard",
              "props": {
                "query": null,
                "externalTool": {
                  "toolId": "__PHARMA_TOOL_ID__",
                  "toolName": "__PHARMA_TOOL_NAME__",
                  "parameters": {
                    "sql": "SELECT COUNT(*) as value FROM sc_supplier_contracts WHERE status = 'Active'"
                  }
                },
                "title": "Active Contracts",
                "description": "Currently active supplier contracts",
                "config": {
                  "valueKey": "value",
                  "formatNumber": true,
                  "icon": "mdi:file-sign",
                  "iconColor": "#f59e0b"
                }
              }
            },
            {
              "id": "kpi-avg-lead-time",
              "type": "KPICard",
              "name": "DynamicKPICard",
              "props": {
                "query": null,
                "externalTool": {
                  "toolId": "__PHARMA_TOOL_ID__",
                  "toolName": "__PHARMA_TOOL_NAME__",
                  "parameters": {
                    "sql": "SELECT ROUND(AVG(lead_time_days)::numeric, 0) as value FROM sc_supplier_master WHERE lead_time_days IS NOT NULL"
                  }
                },
                "title": "Avg Lead Time (days)",
                "description": "Average supplier lead time in days",
                "config": {
                  "valueKey": "value",
                  "formatNumber": true,
                  "icon": "mdi:clock-outline",
                  "iconColor": "#8b5cf6"
                }
              }
            },
            {
              "id": "md-supplier-risk-section",
              "type": "MarkdownBlock",
              "name": "DynamicMarkdownBlock",
              "props": {
                "content": "---\n\n## Risk & Quality Assessment\n\nThe following visualizations provide insight into the supplier risk landscape and procurement spend concentration. Identifying high-risk suppliers and spend dependencies is essential for supply chain resilience."
              }
            },
            {
              "id": "pie-supplier-risk",
              "type": "PieChart",
              "name": "DynamicPieChart",
              "props": {
                "query": null,
                "externalTool": {
                  "toolId": "__PHARMA_TOOL_ID__",
                  "toolName": "__PHARMA_TOOL_NAME__",
                  "parameters": {
                    "sql": "SELECT risk_level as label, COUNT(*) as value FROM sc_supplier_master WHERE risk_level IS NOT NULL GROUP BY risk_level"
                  }
                },
                "title": "Suppliers by Risk Level",
                "description": "Distribution of suppliers by assessed risk level",
                "config": {
                  "nameKey": "label",
                  "valueKey": "value"
                }
              }
            },
            {
              "id": "bar-spend-supplier",
              "type": "BarChart",
              "name": "DynamicBarChart",
              "props": {
                "query": null,
                "externalTool": {
                  "toolId": "__PHARMA_TOOL_ID__",
                  "toolName": "__PHARMA_TOOL_NAME__",
                  "parameters": {
                    "sql": "SELECT supplier_name as label, ROUND(total_spend_ytd::numeric, 0) as value FROM sc_supplier_master WHERE total_spend_ytd > 0 ORDER BY value DESC"
                  }
                },
                "title": "YTD Spend by Supplier",
                "description": "Year-to-date procurement spend per supplier",
                "config": {
                  "xAxisKey": "label",
                  "yAxisKey": "value"
                }
              }
            },
            {
              "id": "md-supplier-contracts-section",
              "type": "MarkdownBlock",
              "name": "DynamicMarkdownBlock",
              "props": {
                "content": "## Contract Coverage\n\nContract status tracking ensures all active suppliers have valid agreements in place. Expired or pending contracts represent potential compliance and supply risks."
              }
            },
            {
              "id": "pie-contract-status",
              "type": "PieChart",
              "name": "DynamicPieChart",
              "props": {
                "query": null,
                "externalTool": {
                  "toolId": "__PHARMA_TOOL_ID__",
                  "toolName": "__PHARMA_TOOL_NAME__",
                  "parameters": {
                    "sql": "SELECT status as label, COUNT(*) as value FROM sc_supplier_contracts GROUP BY status ORDER BY value DESC"
                  }
                },
                "title": "Contract Status",
                "description": "Supplier contract status distribution",
                "config": {
                  "nameKey": "label",
                  "valueKey": "value"
                }
              }
            },
            {
              "id": "md-supplier-details-section",
              "type": "MarkdownBlock",
              "name": "DynamicMarkdownBlock",
              "props": {
                "content": "---\n\n## Supplier Master Data\n\nThe table below provides a detailed view of all suppliers including qualification status, quality ratings, risk levels, and on-time delivery performance."
              }
            },
            {
              "id": "table-supplier-details",
              "type": "DataTable",
              "name": "DynamicDataTable",
              "props": {
                "query": null,
                "externalTool": {
                  "toolId": "__PHARMA_TOOL_ID__",
                  "toolName": "__PHARMA_TOOL_NAME__",
                  "parameters": {
                    "sql": "SELECT supplier_id, supplier_name, category, country, qualification_status, risk_level, quality_rating, on_time_delivery_rate FROM sc_supplier_master ORDER BY supplier_name LIMIT 20"
                  }
                },
                "title": "Supplier Details",
                "description": "Supplier master data with quality and delivery metrics",
                "config": {
                  "title": "Supplier Details"
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
