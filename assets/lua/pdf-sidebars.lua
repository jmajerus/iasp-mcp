-- pdf-sidebars.lua
-- Map semantic asides (epub:type="aside" or legacy class "sidebar")
-- to the LaTeX 'sidebar' environment for PDF output.

local function has_epub_type(value, token)
  if not value then
    return false
  end

  for word in value:gmatch("%S+") do
    if word:lower() == token then
      return true
    end
  end

  return false
end

local function is_sidebar_div(el)
  -- Check epub:type attribute (case-insensitive key)
  if el.attributes then
    for k, v in pairs(el.attributes) do
      if k:lower() == "epub:type" and (has_epub_type(v, "aside") or has_epub_type(v, "sidebar")) then
        return true
      end
    end
  end

  -- Fallback: semantic classes
  if el.classes then
    for _, c in ipairs(el.classes) do
      local lowered = c:lower()
      if lowered == "aside" or lowered == "sidebar" then
        return true
      end
    end
  end

  return false
end

return {
  {
    Div = function(el)
      if not FORMAT:match("latex") then
        return nil
      end

      if not is_sidebar_div(el) then
        return nil
      end

      local blocks = {}

      table.insert(blocks, pandoc.RawBlock("latex", "\\begin{sidebar}"))
      for _, b in ipairs(el.content) do
        table.insert(blocks, b)
      end
      table.insert(blocks, pandoc.RawBlock("latex", "\\end{sidebar}"))

      return blocks
    end
  }
}

