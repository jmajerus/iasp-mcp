local utils = pandoc.utils

local M = {}

local SHORTHAND_BASES = {
  callout = true,
  note = true,
  example = true,
  definition = true,
  sidebar = true,
  aside = true,
  ["sidebar-inline"] = true,
  bridge = true,
  bridgehead = true,
  epigraph = true,
  ["epigraph-inline"] = true,
  include = true
}

local function add_unique(tbl, value)
  for _, existing in ipairs(tbl) do
    if existing == value then
      return
    end
  end
  table.insert(tbl, value)
end

local function parse_shorthand_marker(text)
  local body = text:match("^:::%s*(.-)%s*$")
  if not body or body == "" then
    return nil
  end

  local head, rest = body:match("^([^%s]+)%s*(.*)$")
  if not head or head == "" then
    return nil
  end

  local classes = {}
  for part in head:gmatch("[^%.]+") do
    local lowered = part:lower()
    if lowered ~= "" then
      table.insert(classes, lowered)
    end
  end

  if #classes == 0 then
    return nil
  end

  local base = classes[1]
  if not SHORTHAND_BASES[base] then
    return nil
  end

  local normalized = {}
  for _, cls in ipairs(classes) do
    add_unique(normalized, cls)
  end

  local attributes = {}
  if rest and rest ~= "" then
    for key, value in rest:gmatch('([%w_%-%:]+)%s*=%s*"(.-)"') do
      attributes[key] = value
    end
    for key, value in rest:gmatch("([%w_%-%:]+)%s*=%s*'(.-)'") do
      attributes[key] = value
    end
  end

  return {
    base = base,
    classes = normalized,
    attributes = attributes
  }
end

local function shorthand_is_closer(block)
  if block.t ~= "Para" and block.t ~= "Plain" then
    return false
  end

  local text = utils.stringify(block)
  return text:match("^:::%s*$") ~= nil
end

function M.convert_shorthand_blocks(blocks)
  local out = {}
  local i = 1

  while i <= #blocks do
    if blocks[i].t == "Div" and blocks[i].content then
      blocks[i].content = M.convert_shorthand_blocks(blocks[i].content)
    end

    local token = nil

    if blocks[i].t == "Para" or blocks[i].t == "Plain" then
      token = parse_shorthand_marker(utils.stringify(blocks[i]))
    end

    if token then
      local inner = {}
      local j = i + 1
      local closed = false

      while j <= #blocks do
        if shorthand_is_closer(blocks[j]) then
          closed = true
          break
        end
        table.insert(inner, blocks[j])
        j = j + 1
      end

      if closed then
        local attr = pandoc.Attr("", token.classes, token.attributes or {})
        local div = pandoc.Div(inner, attr)
        table.insert(out, div)
        i = j + 1
        goto continue
      end
      -- If no closer is found, fall through and treat text literally.
    end

    table.insert(out, blocks[i])
    i = i + 1
    ::continue::
  end

  return out
end

function M.preprocess_shorthand(doc, capture_meta)
  if capture_meta then
    capture_meta(doc.meta)
  end
  doc.blocks = M.convert_shorthand_blocks(doc.blocks)
  return doc
end

return M
