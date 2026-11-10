local M = {}

local function collect_sidebar_blocks(blocks, i)
  local collected = {}
  local h = blocks[i]
  local level = h.level or 0
  table.insert(collected, h)
  i = i + 1

  while i <= #blocks do
    local b = blocks[i]

    if b.t == "HorizontalRule" then
      i = i + 1
      break
    end

    if b.t == "Header" and b.level <= level then
      break
    end

    table.insert(collected, b)
    i = i + 1
  end

  return collected, i
end

function M.create(opts)
  local function latex_sidebar_wrapper(doc)
    if not FORMAT:match("latex") then
      return doc
    end

    local blocks = doc.blocks
    local out = {}
    local i = 1

    while i <= #blocks do
      local b = blocks[i]

      if b.t == "Header" then
        opts.apply_semantic_aliases(b)

        if b.attributes and b.attributes["epub:type"] then
          local is_inline = opts.has_epub_type(b.attributes, "sidebar-inline")
          if is_inline or opts.has_epub_type(b.attributes, "aside") or opts.has_epub_type(b.attributes, "sidebar") then
            if is_inline then
              opts.inject_sidebar_glyph(b)
            end
            local collected
            collected, i = collect_sidebar_blocks(blocks, i)

            local env = is_inline and "sidebartight" or "sidebar"
            table.insert(out, pandoc.RawBlock("latex", "\\begin{" .. env .. "}"))
            -- Skip badge if .nobadge class is present or for inline sidebars
            if not is_inline and not opts.has_class(b, "nobadge") then
              table.insert(out, pandoc.RawBlock("latex", "\\sidebarbadge"))
            end
            for _, cb in ipairs(collected) do
              table.insert(out, cb)
            end
            table.insert(out, pandoc.RawBlock("latex", "\\end{" .. env .. "}"))
            goto continue
          end
        end
      end

      table.insert(out, b)
      i = i + 1
      ::continue::
    end

    doc.blocks = out
    return doc
  end

  return {
    latex_sidebar_wrapper = latex_sidebar_wrapper,
  }
end

return M
