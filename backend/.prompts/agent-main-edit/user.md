Current Date and Time: {{CURRENT_DATETIME}}

Apply this change to the script shown in your context:

{{EDIT_INSTRUCTION}}

Remember:
- Change ONLY what this instruction names. Every other predicate, JOIN, GROUP BY, column and parameter stays byte-identical.
- Go straight to `write_script` unless the change needs data the script body does not already contain.
- Your VERY FIRST action must be a tool call — `write_script` for a body-only change, or one narrow source query if you must look up an exact column name or filter value. Do not reply with a plan or "I'll update…" first.
- After `execute_script` returns ok, write the analysis that answers the original question with the corrected data, opening with one line stating what changed.

{{USER_PROMPT}}
