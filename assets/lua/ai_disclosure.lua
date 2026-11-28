--[[
ai_disclosure.lua: place the AI disclosure block that iasp-mcp resolved (src/ai-credit.ts).

The block arrives as metadata `iasp-ai-disclosure`: the path of a JSON file
  { "paragraphs": ["<markdown>", ...], "variant": "ai", "position": "top" | "end" }
It becomes a `::: {.note .<variant>}` Div, so iasp-semantics.lua (which runs after this filter) styles it like
any other note.

  position "top": directly after the leading level-1 heading (the article title), or at the top of the body;
  position "end": before the first level-2+ heading named Works Cited, References, or Bibliography
                  (case-insensitive), or at the end of the body.

A fenced wrapper such as `::: {.article}` is searched too, so the block lands inside it.
]]

local function read_block(meta)
  local path = meta["iasp-ai-disclosure"]
  if not path then return nil end
  path = pandoc.utils.stringify(path)
  if path == "" then return nil end
  local fh = io.open(path, "r")
  if not fh then return nil end
  local raw = fh:read("*a")
  fh:close()
  local ok, decoded = pcall(function() return pandoc.json.decode(raw, false) end)
  if not ok or type(decoded) ~= "table" or type(decoded.paragraphs) ~= "table" then return nil end
  return decoded
end

local function build_div(block)
  local content = pandoc.Blocks({})
  for _, para in ipairs(block.paragraphs) do
    content:extend(pandoc.read(para, "markdown").blocks)
  end
  if #content == 0 then return nil end
  local variant = (type(block.variant) == "string" and block.variant ~= "") and block.variant:lower() or "ai"
  return pandoc.Div(content, pandoc.Attr("", { "note", variant }, { ["data-iasp-ai-disclosure"] = "true" }))
end

local function is_references_heading(b)
  if b.t ~= "Header" or b.level < 2 then return false end
  local text = pandoc.utils.stringify(b.content):lower()
  return text:match("^works cited") or text:match("^references") or text:match("^bibliography")
end

-- Insert before the first references heading, searching into Divs; true when inserted.
local function insert_before_references(blocks, div)
  for i, b in ipairs(blocks) do
    if is_references_heading(b) then
      blocks:insert(i, div)
      return true
    end
    if b.t == "Div" and insert_before_references(b.content, div) then return true end
  end
  return false
end

-- Insert after a leading level-1 heading, searching into a leading wrapper Div.
local function insert_at_top(blocks, div)
  local first = blocks[1]
  if first and first.t == "Div" then
    insert_at_top(first.content, div)
    return
  end
  if first and first.t == "Header" and first.level == 1 then
    blocks:insert(2, div)
  else
    blocks:insert(1, div)
  end
end

-- Append at the end of the body: inside a single wrapper Div when the body is one.
local function insert_at_end(blocks, div)
  local last = blocks[#blocks]
  if #blocks == 1 and last.t == "Div" then
    last.content:insert(div)
  else
    blocks:insert(div)
  end
end

return {
  {
    Pandoc = function(doc)
      local block = read_block(doc.meta)
      if not block then return nil end
      local div = build_div(block)
      if not div then return nil end
      if block.position == "top" then
        insert_at_top(doc.blocks, div)
      elseif block.position == "end" then
        if not insert_before_references(doc.blocks, div) then insert_at_end(doc.blocks, div) end
      else
        return nil
      end
      return doc
    end,
  },
}
