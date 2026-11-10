local M = {}

local function count_table_rows(table_block)
  if not table_block or table_block.t ~= "Table" then
    return 0
  end

  local count = 0
  local head = table_block.head
  if head and head.rows then
    count = count + #head.rows
  end
  local bodies = table_block.bodies
  if bodies then
    for _, body in ipairs(bodies) do
      if body.rows then
        count = count + #body.rows
      end
    end
  end
  local foot = table_block.foot
  if foot and foot.rows then
    count = count + #foot.rows
  end

  return count
end

local function count_table_columns(table_block)
  if not table_block or table_block.t ~= "Table" then
    return 0
  end

  if table_block.colspecs then
    return #table_block.colspecs
  end

  local c = table_block.c
  if type(c) == "table" and type(c[2]) == "table" then
    return #c[2]
  end

  return 0
end

-- Estimate character width of cell content by walking the AST
local function estimate_cell_width(cell)
  if not cell then return 0 end
  local width = 0
  
  local function walk(elem)
    if type(elem) == "string" then
      width = width + #elem
    elseif elem.t == "Str" then
      width = width + #(elem.text or "")
    elseif elem.t == "Space" or elem.t == "SoftBreak" then
      width = width + 1
    elseif elem.t == "LineBreak" then
      width = width + 1
    elseif elem.t == "Code" then
      width = width + #(elem.text or "")
    elseif elem.t == "Math" then
      width = width + #(elem.text or "")
    elseif elem.content then
      for _, child in ipairs(elem.content) do
        walk(child)
      end
    elseif elem.c then
      if type(elem.c) == "table" then
        for _, child in ipairs(elem.c) do
          walk(child)
        end
      elseif type(elem.c) == "string" then
        width = width + #elem.c
      end
    end
  end
  
  -- Cell structure: cell.contents is a list of blocks
  local contents = cell.contents or cell[2] or {}
  for _, block in ipairs(contents) do
    walk(block)
  end
  
  return width
end

-- Estimate max width per column across all rows
local function estimate_column_widths(tbl)
  if not tbl or tbl.t ~= "Table" then
    return {}, 0
  end
  
  local col_widths = {}
  local num_cols = count_table_columns(tbl)
  for i = 1, num_cols do
    col_widths[i] = 0
  end
  
  local function process_row(row)
    if not row or not row.cells then return end
    for i, cell in ipairs(row.cells) do
      if i <= num_cols then
        local w = estimate_cell_width(cell)
        if w > col_widths[i] then
          col_widths[i] = w
        end
      end
    end
  end
  
  -- Process header rows
  if tbl.head and tbl.head.rows then
    for _, row in ipairs(tbl.head.rows) do
      process_row(row)
    end
  end
  
  -- Process body rows
  if tbl.bodies then
    for _, body in ipairs(tbl.bodies) do
      if body.body then
        for _, row in ipairs(body.body) do
          process_row(row)
        end
      end
      if body.rows then
        for _, row in ipairs(body.rows) do
          process_row(row)
        end
      end
    end
  end
  
  -- Process footer rows
  if tbl.foot and tbl.foot.rows then
    for _, row in ipairs(tbl.foot.rows) do
      process_row(row)
    end
  end
  
  local total = 0
  for _, w in ipairs(col_widths) do
    total = total + w
  end
  
  return col_widths, total
end

-- Threshold: estimated character width that suggests compact styling needed
-- ~80 chars is typical page width; tables exceeding this benefit from smaller font
local COMPACT_WIDTH_THRESHOLD = 90

-- Fix table colspecs to use proportional widths based on content
-- This ensures columns wrap properly instead of overflowing
local function fix_table_colspecs(tbl)
  if not tbl or tbl.t ~= "Table" then
    return false
  end
  
  local col_widths, total_width = estimate_column_widths(tbl)
  local num_cols = #col_widths
  
  if num_cols == 0 or total_width == 0 then
    return false
  end
  
  -- Always recalculate column widths based on content
  -- Pandoc's default calculation often produces columns that are too narrow
  -- for unwrappable content like identifiers
  
  -- Calculate proportional widths based on estimated content
  -- Use content width as minimum - identifiers can't wrap
  local adjusted_widths = {}
  local adjusted_total = 0
  
  -- First pass: calculate raw proportions
  for i, w in ipairs(col_widths) do
    -- Proportional to content, with a floor based on character width
    -- Assume ~80 chars fit on a page, so each char is ~1.25% width
    -- Add 5% padding to prevent edge-case overlaps
    local min_width_needed = (w + 4) / 80.0
    if min_width_needed < 0.08 then
      min_width_needed = 0.08  -- 8% absolute minimum
    end
    if min_width_needed > 0.60 then
      min_width_needed = 0.60  -- 60% maximum for any single column
    end
    adjusted_widths[i] = min_width_needed
    adjusted_total = adjusted_total + min_width_needed
  end
  
  -- If total exceeds 1.0, we need to normalize while respecting minimums
  -- for unwrappable content (first column typically has identifiers)
  if adjusted_total > 1.0 then
    -- Scale down, but protect columns with long unwrappable content
    local scale = 1.0 / adjusted_total
    for i, w in ipairs(adjusted_widths) do
      adjusted_widths[i] = w * scale
    end
    adjusted_total = 1.0
  end
  
  -- Normalize to sum to 1.0
  local new_colspecs = {}
  for i, spec in ipairs(tbl.colspecs) do
    local align = spec[1] or "AlignDefault"
    local width = adjusted_widths[i] / adjusted_total
    new_colspecs[i] = { align, width }
  end
  
  tbl.colspecs = new_colspecs
  return true
end

function M.div_table_row_count(div)
  if not div or not div.content then
    return 0
  end
  local total = 0
  for _, block in ipairs(div.content) do
    if block.t == "Table" then
      total = total + count_table_rows(block)
    end
  end
  return total
end

function M.div_table_column_count(div)
  if not div or not div.content then
    return 0
  end
  local max_cols = 0
  for _, block in ipairs(div.content) do
    if block.t == "Table" then
      local cols = count_table_columns(block)
      if cols > max_cols then
        max_cols = cols
      end
    end
  end
  return max_cols
end

function M.create(opts)
  local function apply_table_appearance(div, format_hint)
    if not div or not div.content then
      return false
    end

    local wants_compact = opts.has_class(div, "table-compact")
    local wants_striped = opts.has_class(div, "table-striped")
    local wants_bordered = opts.has_class(div, "table-bordered")

    if not (wants_compact or wants_striped or wants_bordered) then
      return false
    end

    if not format_hint:match("latex") then
      return false
    end

    local updated = false
    local next_blocks = {}

    for _, block in ipairs(div.content) do
      if block.t == "Table" then
        -- Check if already wrapped by a prior pass (e.g. handle_bare_table ran
        -- first in bottom-up traversal and inserted RawBlock wrappers before us).
        local prev = next_blocks[#next_blocks]
        local already_wrapped = prev and prev.t == "RawBlock" and prev.format == "latex"
          and prev.text:find("\\iaspTableCompactStart")
        if wants_compact and not already_wrapped then
          table.insert(next_blocks, pandoc.RawBlock("latex", "\\iaspTableCompactStart\n"))
        end
        if wants_bordered then
          table.insert(next_blocks, pandoc.RawBlock("latex", "\\begin{iaspTableBordered}\n"))
        end
        if wants_striped then
          table.insert(next_blocks, pandoc.RawBlock("latex", "\\iaspTableStripedStart\n"))
        end

        table.insert(next_blocks, block)

        if wants_striped then
          table.insert(next_blocks, pandoc.RawBlock("latex", "\\iaspTableStripedEnd\n"))
        end
        if wants_bordered then
          table.insert(next_blocks, pandoc.RawBlock("latex", "\\end{iaspTableBordered}\n"))
        end
        if wants_compact and not already_wrapped then
          table.insert(next_blocks, pandoc.RawBlock("latex", "\\iaspTableCompactEnd\n"))
        end
        updated = true
      else
        table.insert(next_blocks, block)
      end
    end

    if updated then
      div.content = next_blocks
    end

    return updated
  end

  local function apply_table_layout(div, format_hint, has_fullpage_layout, mutated)
    local has_table_semantics = opts.has_class(div, "table")

    if has_table_semantics and not has_fullpage_layout then
      local min_rows = opts.table_fullpage_min_rows()
      if min_rows and min_rows > 0 then
        local table_rows = M.div_table_row_count(div)
        if table_rows >= min_rows then
          opts.add_unique(div.classes, "layout-fullpage")
          opts.add_unique(div.classes, "table-fullpage")
          has_fullpage_layout = true
          mutated = true
        end
      end
    elseif has_table_semantics and has_fullpage_layout then
      opts.add_unique(div.classes, "table-fullpage")
    end

    -- Content-based auto-compact: examine actual cell widths
    if has_table_semantics and not opts.has_class(div, "table-compact") then
      for _, block in ipairs(div.content) do
        if block.t == "Table" then
          local _, total_width = estimate_column_widths(block)
          if total_width >= COMPACT_WIDTH_THRESHOLD then
            opts.add_unique(div.classes, "table-compact")
            mutated = true
            break
          end
        end
      end
    end

    -- Fix column widths for all tables in the div
    if has_table_semantics then
      for _, block in ipairs(div.content) do
        if block.t == "Table" then
          if fix_table_colspecs(block) then
            mutated = true
          end
        end
      end
    end

    if has_table_semantics then
      if apply_table_appearance(div, format_hint) then
        mutated = true
      end
    end

    return has_fullpage_layout, mutated
  end

  -- Handle bare tables (not wrapped in .table divs)
  -- Fixes column widths and applies compact styling if needed
  local function handle_bare_table(tbl, format_hint)
    if not tbl or tbl.t ~= "Table" then
      return nil
    end

    -- Always fix column widths for LaTeX output
    local mutated = false
    if format_hint:match("latex") then
      mutated = fix_table_colspecs(tbl)
    end

    -- Estimate content width and decide if compact styling needed
    local _, total_width = estimate_column_widths(tbl)
    local needs_compact = total_width >= COMPACT_WIDTH_THRESHOLD

    if not format_hint:match("latex") then
      -- For non-LaTeX, just return the possibly-modified table
      if mutated then
        return tbl
      end
      return nil
    end

    if needs_compact then
      -- Wrap table with compact styling
      return {
        pandoc.RawBlock("latex", "\\iaspTableCompactStart\n"),
        tbl,
        pandoc.RawBlock("latex", "\\iaspTableCompactEnd\n"),
      }
    elseif mutated then
      -- Column widths fixed but no compact styling needed
      return tbl
    end

    return nil
  end

  return {
    apply_table_layout = apply_table_layout,
    handle_bare_table = handle_bare_table,
  }
end

return M
