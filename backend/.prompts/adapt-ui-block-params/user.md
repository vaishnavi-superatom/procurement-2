Current Date and Time: {{CURRENT_DATETIME}}

## Previous Matched UIBlock

**Original Question:** {{ORIGINAL_USER_PROMPT}}

**Matched UIBlock Component:**
```json
{{MATCHED_UI_BLOCK_COMPONENT}}
```

**Component Properties:**
```json
{{COMPONENT_PROPS}}
```

**Cached Text Response (Analysis):**
{{CACHED_TEXT_RESPONSE}}

## Current User Question
{{CURRENT_USER_PROMPT}}

---

## Adaptation Instructions

1. **Analyze the difference** between the original question and the current question
2. **Identify what data needs to change**:
   - For single components: adapt the query/config
   - For MultiComponentContainer: adapt the container title/description AND each nested component's parameters

3. **Modify the parameters**:
   - **Container level** (if MultiComponentContainer):
     - Update `title` and `description` to reflect the new user question

   - **For each component** (single or nested in container):
     - Identify what it shows (sales, revenue, inventory, etc.)
     - Adapt SQL queries: modify WHERE clauses, LIMIT, ORDER BY, filters, date ranges
     - Update component title and description
     - Update config settings (metrics, colors, sorting, grouping)

4. **Preserve structure**: Keep the same number and type of components

5. **Adapt the text response**: Update the cached text response to match the new question:
   - Replace entity names, IDs, and references that correspond to parameters changed in the new question
   - Replace specific numeric values with placeholders like "[calculated value]" since actual data will come from the adapted queries
   - Keep the same structure and formatting

6. **Return complete JSON** with all adapted properties for all components AND the adapted text response
