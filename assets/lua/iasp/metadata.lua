local utils = pandoc.utils

local M = {}

local document_meta = {}
local container_wrapper_map = {}
local article_mode_cache = nil
local frontmatter_enabled_cache = nil
local backmatter_enabled_cache = nil
local named_block_badges_enabled_cache = nil
local named_note_badges_enabled_cache = nil
local table_fullpage_min_rows_cache = nil
local table_compact_min_cols_cache = nil

local function meta_to_plain(node)
  if node == nil then
    return nil
  end

  if type(node) ~= "table" or node.t == nil then
    return node
  end

  local tag = node.t

  if tag == "MetaString" then
    return node.text
  elseif tag == "MetaInlines" or tag == "MetaBlocks" then
    return utils.stringify(node)
  elseif tag == "MetaBool" then
    return node.boolean
  elseif tag == "MetaList" then
    local list = {}
    for _, value in ipairs(node) do
      table.insert(list, meta_to_plain(value))
    end
    return list
  elseif tag == "MetaMap" then
    local map = {}
    for key, value in pairs(node) do
      map[key] = meta_to_plain(value)
    end
    return map
  elseif tag == "MetaInt" or tag == "MetaDouble" or tag == "MetaNumber" then
    return node.value
  end

  return utils.stringify(node)
end

local function build_wrapper_map(meta_node)
  local map = {}
  if not meta_node then
    return map
  end

  local plain = meta_to_plain(meta_node)
  if type(plain) ~= "table" then
    return map
  end

  local list
  if plain[1] ~= nil then
    list = plain
  else
    list = {}
    for _, value in pairs(plain) do
      table.insert(list, value)
    end
  end

  for _, entry in ipairs(list) do
    if type(entry) == "table" then
      local rel_path = entry.path or entry.rel_path or entry.file
      if rel_path and type(rel_path) == "string" then
        map[rel_path] = entry
      end
    end
  end

  return map
end

function M.capture_document_meta(meta)
  document_meta = {}
  container_wrapper_map = {}
  article_mode_cache = nil
  frontmatter_enabled_cache = nil
  backmatter_enabled_cache = nil
  named_block_badges_enabled_cache = nil
  named_note_badges_enabled_cache = nil
  table_fullpage_min_rows_cache = nil
  table_compact_min_cols_cache = nil
  if meta then
    for key, value in pairs(meta) do
      document_meta[key] = value
    end
  end
  container_wrapper_map = build_wrapper_map(document_meta["container-wrappers"])
  return nil
end

function M.container_wrapper_map()
  return container_wrapper_map
end

function M.meta_value(key)
  if not document_meta or not key then
    return nil
  end

  local node = document_meta[key]
  if not node then
    return nil
  end

  return utils.stringify(node)
end

function M.truthy_string(value)
  if value == nil then
    return false
  end
  local lowered = tostring(value):lower()
  return lowered == "1" or lowered == "true" or lowered == "yes" or lowered == "on"
end

function M.named_block_badges_enabled()
  if named_block_badges_enabled_cache ~= nil then
    return named_block_badges_enabled_cache
  end

  local raw = M.meta_value("layout-named-block-badges")
  if not raw or raw == "" then
    raw = M.meta_value("named-block-badges") or M.meta_value("named_block_badges")
  end

  if not raw or raw == "" then
    named_block_badges_enabled_cache = false
    return named_block_badges_enabled_cache
  end

  named_block_badges_enabled_cache = M.truthy_string(raw)
  return named_block_badges_enabled_cache
end

function M.named_note_badges_enabled()
  if named_note_badges_enabled_cache ~= nil then
    return named_note_badges_enabled_cache
  end

  local raw = M.meta_value("layout-named-note-badges")
  if not raw or raw == "" then
    raw = M.meta_value("named-note-badges") or M.meta_value("named_note_badges")
  end

  if not raw or raw == "" then
    named_note_badges_enabled_cache = false
    return named_note_badges_enabled_cache
  end

  named_note_badges_enabled_cache = M.truthy_string(raw)
  return named_note_badges_enabled_cache
end

function M.table_fullpage_min_rows()
  if table_fullpage_min_rows_cache ~= nil then
    return table_fullpage_min_rows_cache
  end

  local raw = M.meta_value("layout-table-fullpage-min-rows")
  if not raw or raw == "" then
    raw = M.meta_value("table-fullpage-min-rows") or M.meta_value("table_fullpage_min_rows")
  end

  local value = tonumber(raw)
  if not value or value <= 0 then
    table_fullpage_min_rows_cache = 0
    return table_fullpage_min_rows_cache
  end

  table_fullpage_min_rows_cache = math.floor(value)
  return table_fullpage_min_rows_cache
end

-- Legacy: kept for backward compatibility but no longer used.
-- Auto-compact now uses content-based width estimation.
function M.table_compact_min_cols()
  if table_compact_min_cols_cache ~= nil then
    return table_compact_min_cols_cache
  end

  local raw = M.meta_value("layout-table-compact-min-cols")
  if not raw or raw == "" then
    raw = M.meta_value("table-compact-min-cols") or M.meta_value("table_compact_min_cols")
  end

  local value = tonumber(raw)
  if not value or value <= 0 then
    table_compact_min_cols_cache = 0
    return table_compact_min_cols_cache
  end

  table_compact_min_cols_cache = math.floor(value)
  return table_compact_min_cols_cache
end

local table_auto_compact_cache = nil

function M.table_auto_compact_enabled()
  if table_auto_compact_cache ~= nil then
    return table_auto_compact_cache
  end
  
  local raw = M.meta_value("layout-table-auto-compact")
  if not raw or raw == "" then
    raw = M.meta_value("table-auto-compact") or M.meta_value("table_auto_compact")
  end
  
  -- Default to true if not specified
  if raw == nil or raw == "" then
    table_auto_compact_cache = true
    return table_auto_compact_cache
  end
  
  table_auto_compact_cache = M.truthy_string(raw)
  return table_auto_compact_cache
end

function M.article_build_enabled()
  if article_mode_cache ~= nil then
    return article_mode_cache
  end
  article_mode_cache = M.truthy_string(M.meta_value("article-build"))
  return article_mode_cache
end

function M.resolve_toggle(meta_key, default_state)
  local value = M.meta_value(meta_key)
  if value ~= nil and value ~= "" then
    return M.truthy_string(value)
  end
  return default_state
end

function M.frontmatter_enabled()
  if frontmatter_enabled_cache ~= nil then
    return frontmatter_enabled_cache
  end
  frontmatter_enabled_cache = M.resolve_toggle("frontmatter-enabled", not M.article_build_enabled())
  return frontmatter_enabled_cache
end

function M.backmatter_enabled()
  if backmatter_enabled_cache ~= nil then
    return backmatter_enabled_cache
  end
  backmatter_enabled_cache = M.resolve_toggle("backmatter-enabled", not M.article_build_enabled())
  return backmatter_enabled_cache
end

return M
