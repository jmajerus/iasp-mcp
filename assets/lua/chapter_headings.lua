local function has_class(el, class_name)
  if not el or not el.classes then
    return false
  end
  for _, cls in ipairs(el.classes) do
    if cls == class_name then
      return true
    end
  end
  return false
end

local function has_epub_type(attr, token)
  if not attr then
    return false
  end
  local spec = attr["epub:type"]
  if not spec or spec == "" then
    return false
  end
  for value in spec:gmatch("%S+") do
    if value == token then
      return true
    end
  end
  return false
end

local function add_epub_type_token(attr, token)
  if not attr then
    return false
  end
  local spec = attr["epub:type"]
  if not spec or spec == "" then
    attr["epub:type"] = token
    return true
  end
  for value in spec:gmatch("%S+") do
    if value == token then
      return false
    end
  end
  attr["epub:type"] = spec .. " " .. token
  return true
end

local function div_has_chapter_semantics(div)
  if not div then
    return false
  end
  if has_class(div, "chapter") then
    return true
  end
  return has_epub_type(div.attributes, "chapter")
end

local function primary_chapter_header(div)
  if not div or not div.content then
    return nil
  end
  local candidate = nil
  local function is_epigraph_header(header)
    if not header or not header.attributes then
      return false
    end
    if has_epub_type(header.attributes, "epigraph") or has_epub_type(header.attributes, "epigraph-inline") then
      return true
    end
    if header.classes then
      for _, cls in ipairs(header.classes) do
        if cls == "epigraph" or cls == "epigraph-inline" then
          return true
        end
      end
    end
    return false
  end
  for _, block in ipairs(div.content) do
    if block.t == "Header" then
      if not is_epigraph_header(block) then
        candidate = block
      end
    else
      break
    end
  end
  return candidate
end

function Div(div)
  if not div_has_chapter_semantics(div) then
    return nil
  end
  local header = primary_chapter_header(div)
  if not header then
    return nil
  end
  header.attributes = header.attributes or {}
  add_epub_type_token(header.attributes, "chapter")
  return div
end
