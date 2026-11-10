-- title_from_first_heading.lua
-- Promote the first heading in a document to the metadata title when the
-- document lacks an explicit title. This keeps sidebars/standalone inserts
-- from showing raw file identifiers in EPUB/PDF navigation.

local utils = pandoc.utils

local NAV_COMMENT_PREFIX = "nav-title:"

local function has_text(value)
  return value and value:match("%S") ~= nil
end

local function meta_has_title(meta)
  if not meta then
    return false
  end
  local title = meta.title
  if not title then
    return false
  end
  local text = utils.stringify(title)
  return text ~= nil and text:match("%S") ~= nil
end

local function capture_div_title(blocks)
  if not blocks then
    return nil
  end

  for _, block in ipairs(blocks) do
    if block.t == "Div" then
      local attr = block.attr or { "", {}, {} }
      local attrs = attr[3] or {}
      local title_attr = attrs["data-nav-title"] or attrs["data-title"] or attrs["title"]
      if has_text(title_attr) then
        return title_attr
      end
    end
  end

  return nil
end

local function capture_first_heading(blocks)
  if not blocks then
    return nil
  end

  local first = nil

  local function header_handler(el)
    if first ~= nil then
      return el
    end
    local text = utils.stringify(el.content)
    if text and text:match("%S") then
      first = el
    end
    return el
  end

  local container = pandoc.Div(blocks)
  pandoc.walk_block(container, { Header = header_handler })
  return first
end

local function inject_nav_comment(doc, title_text)
  if not FORMAT:match("html") then
    return
  end
  local sanitized = title_text:gsub("%-%-", "—")
  local marker = string.format("<!-- %s%s -->", NAV_COMMENT_PREFIX, sanitized)
  table.insert(doc.blocks, 1, pandoc.RawBlock("html", marker))
end

local function to_title_inlines(text)
  return pandoc.Inlines({ pandoc.Str(text) })
end

return {
  {
    Pandoc = function(doc)
      -- Skip title injection for article builds (articles manage their own titles)
      if doc.meta and doc.meta["article-build"] then
        return doc
      end

      if meta_has_title(doc.meta) then
        return doc
      end

      local heading = capture_first_heading(doc.blocks)
      if not heading then
        local div_title = capture_div_title(doc.blocks)
        if not div_title then
          return doc
        end

        doc.meta = doc.meta or pandoc.Meta({})
        doc.meta.title = pandoc.MetaInlines(to_title_inlines(div_title))
        inject_nav_comment(doc, div_title)
        return doc
      end

      local title_inlines = pandoc.Inlines(heading.content)
      doc.meta = doc.meta or pandoc.Meta({})
      doc.meta.title = pandoc.MetaInlines(title_inlines)
      return doc
    end,
  },
}
