local utils = pandoc.utils
local path = pandoc.path
local system = pandoc.system

local M = {}

local function attr_truthy(value)
  if value == nil then
    return false
  end
  local lowered = tostring(value):lower()
  return lowered == "1" or lowered == "true" or lowered == "yes" or lowered == "on"
end

local function normalize_newlines(text)
  if not text then
    return ""
  end
  local result = text:gsub("\r\n", "\n")
  result = result:gsub("\r", "\n")
  return result
end

local function normalize_heading_indentation(text)
  if not text then
    return ""
  end
  local result = text:gsub("^[ \t][ \t]?[ \t]?(#+%s)", "%1")
  result = result:gsub("\n[ \t][ \t]?[ \t]?(#+%s)", "\n%1")
  return result
end

local function include_error_blocks(target, reason)
  local message
  if target and target ~= "" then
    message = "[Err: The file '" .. target .. "' could not be inserted here]"
  else
    message = "[Err: An include directive could not be expanded here]"
  end

  if reason and reason ~= "" then
    message = message .. " (" .. reason .. ")"
  end

  message = "(" .. message .. ".)"
  return { pandoc.Para({ pandoc.Str(message) }) }
end

local function resolve_include_path(target)
  if not target or target == "" then
    return nil
  end

  if path and path.is_absolute and path.is_absolute(target) then
    return target
  end

  local cwd = system.get_working_directory()
  if path and path.normalize then
    return path.normalize(cwd .. "/" .. target)
  end
  return cwd .. "/" .. target
end

local function path_is_dir(target)
  local stat = io.popen("test -d '" .. target .. "' && echo dir\n")
  if not stat then
    return false
  end
  local result = stat:read("*l")
  stat:close()
  return result == "dir"
end

local function basename_without_ext(raw)
  if not raw or raw == "" then
    return nil
  end

  local trimmed = raw:gsub("[\\/]+$", "")
  if trimmed == "" then
    trimmed = raw
  end

  local filename
  if path and path.filename then
    filename = path.filename(trimmed)
  else
    filename = trimmed:match("([^/\\]+)$") or trimmed
  end

  if not filename or filename == "" then
    filename = trimmed
  end

  local base = filename:match("^(.*)%.([^%.]+)$")
  if base and base ~= "" then
    return base
  end

  return filename
end

local function parse_target_sequence(raw)
  if not raw or raw == "" then
    return {}
  end

  local entries = {}
  for entry in raw:gmatch("[^,]+") do
    local trimmed = entry:gsub("^%s+", ""):gsub("%s+$", "")
    if trimmed ~= "" then
      table.insert(entries, trimmed)
    end
  end
  return entries
end

local function read_sequence_file_specs(spec_path)
  if not spec_path or spec_path == "" then
    return {}
  end

  local resolved = resolve_include_path(spec_path)
  if not resolved then
    io.stderr:write("[include] unable to resolve list file " .. spec_path .. "\n")
    return {}
  end

  local fh, err = io.open(resolved, "r")
  if not fh then
    io.stderr:write("[include] unable to read list file " .. resolved .. ": " .. (err or "") .. "\n")
    return {}
  end

  local specs = {}
  for line in fh:lines() do
    local trimmed = line:gsub("^%s+", ""):gsub("%s+$", "")
    if trimmed ~= "" and not trimmed:match("^#") then
      table.insert(specs, trimmed)
    end
  end
  fh:close()
  return specs
end

local function list_markdown_files(dir)
  local files = {}
  local p = io.popen("ls -1 '" .. dir .. "'")
  if not p then
    return files
  end
  for entry in p:lines() do
    local candidate = dir .. "/" .. entry
    local stat = io.popen("test -f '" .. candidate .. "' && echo file\n")
    if stat then
      local result = stat:read("*l")
      stat:close()
      if result == "file" and (candidate:match("%.md$") or candidate:match("%.markdown$")) then
        table.insert(files, candidate)
      end
    end
  end
  table.sort(files)
  return files
end

local function read_include_file(resolved)
  local fh, err = io.open(resolved, "r")
  if not fh then
    io.stderr:write("[include] unable to read " .. resolved .. ": " .. (err or "") .. "\n")
    return nil
  end
  local contents = fh:read("*a")
  fh:close()
  return contents
end

local function build_literal_code_block(raw, div, attrs)
  local normalized = normalize_newlines(raw)
  local identifier = ""
  if div.identifier and div.identifier ~= "" then
    identifier = div.identifier
  elseif attrs.id and attrs.id ~= "" then
    identifier = attrs.id
  end

  local classes = {}
  if div.classes then
    for _, cls in ipairs(div.classes) do
      if cls ~= "include" then
        table.insert(classes, cls)
      end
    end
  end

  local attributes = {}
  local lang = attrs.lang or attrs.language
  if lang and lang ~= "" then
    attributes.lang = lang
  end

  return pandoc.CodeBlock(normalized, pandoc.Attr(identifier, classes, attributes))
end

function M.create(opts)
  local include_stack = {}

  local expand_compound_classes = opts.expand_compound_classes
  local enforce_stage_visibility = opts.enforce_stage_visibility
  local enforce_section_visibility = opts.enforce_section_visibility
  local latex_escape_argument = opts.latex_escape_argument
  local begins_with_level_one_header = opts.begins_with_level_one_header
  local apply_section_heading_glyph = opts.apply_section_heading_glyph
  local slugify_identifier_source = opts.slugify_identifier_source
  local namespace_header_identifiers = opts.namespace_header_identifiers
  local convert_shorthand_blocks = opts.convert_shorthand_blocks or function(blocks)
    return blocks
  end

  local function expand_include_div(div)
    if not opts.has_class(div, "include") then
      return nil
    end

    expand_compound_classes(div)
    local allowed = enforce_stage_visibility(div)
    if not allowed then
      return {}
    end

    local section_allowed = enforce_section_visibility(div)
    if not section_allowed then
      return {}
    end

    local attrs = div.attributes or {}
    local target = attrs.path
      or attrs.src
      or attrs.file
      or attrs.dir
      or attrs["data-dir"]
      or attrs["data-path"]
      or attrs["data-src"]
      or attrs["data-file"]

    local sequence_attr = attrs.sequence
      or attrs.paths
      or attrs.files
      or attrs.targets
      or attrs["data-sequence"]
      or attrs["data-paths"]
      or attrs["data-files"]
      or attrs["data-targets"]

    local sequence_file_attr = attrs["sequence-file"]
      or attrs["paths-file"]
      or attrs["files-file"]
      or attrs["targets-file"]
      or attrs["list-file"]
      or attrs["data-sequence-file"]
      or attrs["data-paths-file"]
      or attrs["data-files-file"]
      or attrs["data-targets-file"]
      or attrs["data-list-file"]

    local sequence_specs = nil
    if sequence_attr and sequence_attr ~= "" then
      sequence_specs = parse_target_sequence(sequence_attr)
    end

    local function append_sequence_specs(spec_list)
      if not spec_list or #spec_list == 0 then
        return
      end
      sequence_specs = sequence_specs or {}
      for _, spec in ipairs(spec_list) do
        table.insert(sequence_specs, spec)
      end
    end

    if sequence_file_attr and sequence_file_attr ~= "" then
      local file_specs = {}
      local file_entries = parse_target_sequence(sequence_file_attr)
      if #file_entries == 0 then
        file_entries = { sequence_file_attr }
      end
      for _, file_spec in ipairs(file_entries) do
        local resolved_specs = read_sequence_file_specs(file_spec)
        append_sequence_specs(resolved_specs)
      end
    end

    if (not target or target == "") and (not sequence_specs or #sequence_specs == 0) then
      io.stderr:write("[include] missing path attribute on include block\n")
      return include_error_blocks(nil, "missing path attribute")
    end

    local resolved = nil
    if not sequence_specs then
      resolved = resolve_include_path(target)
      if not resolved then
        io.stderr:write("[include] unable to resolve path for " .. target .. "\n")
        return include_error_blocks(target, "path not found")
      end
    end

    local include_targets = {}
    local first_target_spec = nil

    local attr_mode = attrs.mode
      or attrs["data-mode"]
      or ((attrs.dir or attrs["data-dir"]) and "dir")
      or "file"
    local separator_mode = "rule"
    local section_glyph = nil
    local raw_sep = attrs.separator or attrs.sep or attrs["data-separator"] or attrs["data-sep"]
    if raw_sep then
      local lowered = raw_sep:lower()
      if lowered == "none" or lowered == "false" or lowered == "off" then
        separator_mode = "none"
      end
    end
    local glyph_attr = attrs["glyph"] or attrs["section-glyph"] or attrs["heading-glyph"]
    if glyph_attr and glyph_attr ~= "" then
      section_glyph = glyph_attr
    end
    local banner_text = nil
    local banner_use_filename = false
    local raw_banner = attrs.banner
      or attrs["page-banner"]
      or attrs["running-head"]
      or attrs["runninghead"]
      or attrs["data-banner"]
      or attrs["data-running-head"]
    if raw_banner and raw_banner ~= "" then
      local trimmed = raw_banner:gsub("^%s+", ""):gsub("%s+$", "")
      if trimmed ~= "" then
        local lowered = trimmed:lower()
        if lowered == "filename" or lowered == "file" or lowered == "basename" or lowered == "auto" then
          banner_use_filename = true
        else
          banner_text = trimmed
        end
      end
    end

    local listing_mode = nil
    local raw_listing = attrs.list
      or attrs.listing
      or attrs["list-mode"]
      or attrs["data-list"]
      or attrs["data-listing"]
      or attrs["data-list-mode"]
    if raw_listing and raw_listing ~= "" then
      local lowered = raw_listing:lower()
      if lowered == "name" or lowered == "names" or lowered == "filename" or lowered == "filenames" then
        listing_mode = "filenames"
      elseif lowered == "basename" or lowered == "basenames" then
        listing_mode = "basenames"
      elseif lowered == "path" or lowered == "paths" or lowered == "full" then
        listing_mode = "paths"
      end
    end

    local literal_mode = attr_mode == "literal"
      or attr_mode == "code"
      or opts.has_class(div, "code")
      or opts.has_class(div, "literal")
      or attr_truthy(attrs.literal)

    if sequence_specs and #sequence_specs > 0 then
      for _, spec in ipairs(sequence_specs) do
        local resolved_spec = resolve_include_path(spec)
        if not resolved_spec then
          io.stderr:write("[include] unable to resolve path for " .. spec .. "\n")
        else
          table.insert(include_targets, resolved_spec)
          if not first_target_spec then
            first_target_spec = spec
            if not resolved then
              resolved = resolved_spec
            end
          end
        end
      end
      if #include_targets == 0 then
        local unresolved = sequence_specs and sequence_specs[1] or first_target_spec or target
        return include_error_blocks(unresolved, "no readable targets")
      end
    else
      local is_dir = attr_mode == "dir"
      if not is_dir and resolved then
        if resolved:sub(-1) == "/" or path_is_dir(resolved) then
          is_dir = true
        end
      end

      if is_dir then
        local files = list_markdown_files(resolved:gsub("/$", ""))
        if #files == 0 then
          io.stderr:write("[include] no markdown files found in directory " .. resolved .. "\n")
          return include_error_blocks(target or resolved, "directory has no markdown files")
        end
        include_targets = files
      else
        include_targets = { resolved }
      end
    end

    local is_dir = attr_mode == "dir"
    if not is_dir and resolved then
      if resolved:sub(-1) == "/" or path_is_dir(resolved) then
        is_dir = true
      end
    end

    local namespace_ids = is_dir
    local raw_namespace = attrs["namespace-ids"] or attrs["data-namespace-ids"]
    if raw_namespace ~= nil then
      namespace_ids = attr_truthy(raw_namespace)
    end

    if listing_mode and #include_targets > 0 then
      local list_items = {}
      for _, include_path in ipairs(include_targets) do
        local label
        if listing_mode == "filenames" or listing_mode == "basenames" then
          label = basename_without_ext(include_path) or include_path
        else
          label = include_path
        end

        table.insert(list_items, { pandoc.Plain({ pandoc.Str(label) }) })
      end

      local ordered = false
      local list_style = attrs["list-style"] or attrs["data-list-style"] or attrs["list-type"]
      if list_style and list_style ~= "" then
        local lowered = list_style:lower()
        if lowered == "ordered" or lowered == "numbered" then
          ordered = true
        end
      end

      if ordered then
        return { pandoc.OrderedList(list_items) }
      end

      return { pandoc.BulletList(list_items) }
    end

    local assembled = {}

    local total_targets = #include_targets
    for idx, include_path in ipairs(include_targets) do
      if include_stack[include_path] then
        io.stderr:write("[include] recursive include detected for " .. include_path .. "\n")
        local recursion_blocks = include_error_blocks(include_path, "recursive reference")
        for _, block in ipairs(recursion_blocks) do
          table.insert(assembled, block)
        end
        goto continue
      end

      local contents = read_include_file(include_path)
      if not contents then
        local failure_blocks = include_error_blocks(include_path, "file could not be read")
        for _, block in ipairs(failure_blocks) do
          table.insert(assembled, block)
        end
        goto continue
      end

      local inserted_blocks = false

      if literal_mode then
        table.insert(assembled, build_literal_code_block(contents, div, attrs))
        inserted_blocks = true
      else
        include_stack[include_path] = true
        local ok, included = pcall(function()
          local normalized = normalize_heading_indentation(contents)
          return pandoc.read(normalized, "markdown+citations+fancy_lists+fenced_divs+header_attributes+link_attributes+smart")
        end)
        include_stack[include_path] = nil

        if not ok then
          io.stderr:write("[include] failed to parse " .. include_path .. ": " .. tostring(included) .. "\n")
          goto continue
        end

        included.blocks = convert_shorthand_blocks(included.blocks)
        if section_glyph then
          apply_section_heading_glyph(included.blocks, section_glyph)
        end
        if namespace_ids then
          local file_base = basename_without_ext(include_path)
          local prefix = slugify_identifier_source(file_base)
          if prefix then
            included.blocks = namespace_header_identifiers(included.blocks, prefix, 3)
          end
        end
        -- Transfer .nobadge and .noglyph classes from include div to included content
        local classes_to_transfer = {}
        if opts.has_class(div, "nobadge") then
          table.insert(classes_to_transfer, "nobadge")
        end
        if opts.has_class(div, "noglyph") then
          table.insert(classes_to_transfer, "noglyph")
        end
        
        if #classes_to_transfer > 0 then
          local function add_class_if_missing(classes, class_name)
            for _, cls in ipairs(classes) do
              if cls == class_name then
                return
              end
            end
            table.insert(classes, class_name)
          end
          
          local function transfer_classes_to_content(blocks)
            for _, b in ipairs(blocks) do
              if b.t == "Header" and b.classes then
                for _, class_name in ipairs(classes_to_transfer) do
                  add_class_if_missing(b.classes, class_name)
                end
              elseif b.t == "Div" then
                -- Add to sidebar Divs (so semantic filters can see it)
                if b.classes and opts.has_class(b, "sidebar") then
                  for _, class_name in ipairs(classes_to_transfer) do
                    add_class_if_missing(b.classes, class_name)
                  end
                end
                -- Recurse into nested content
                if b.content then
                  transfer_classes_to_content(b.content)
                end
              end
            end
          end
          transfer_classes_to_content(included.blocks)
        end
        for _, b in ipairs(included.blocks) do
          table.insert(assembled, b)
          inserted_blocks = true
        end
      end

      if inserted_blocks and separator_mode ~= "none" and idx < total_targets then
        table.insert(assembled, pandoc.HorizontalRule())
      end

      ::continue::
    end

    local final_banner_text = banner_text
    if not final_banner_text and banner_use_filename then
      final_banner_text = basename_without_ext(first_target_spec or target)
        or basename_without_ext(resolved)
    end

    if final_banner_text and #assembled > 0 then
      local format_hint = FORMAT or ""
      if format_hint:match("latex") then
        local escaped = latex_escape_argument(final_banner_text)
        local starts_with_level_one = begins_with_level_one_header(assembled)
        local env_name = starts_with_level_one and "includepagebannerchapter" or "includepagebanner"
        local wrapped = { pandoc.RawBlock("latex", "\\begin{" .. env_name .. "}{" .. escaped .. "}\n") }
        for _, block in ipairs(assembled) do
          table.insert(wrapped, block)
        end
        table.insert(wrapped, pandoc.RawBlock("latex", "\\end{" .. env_name .. "}\n"))
        assembled = wrapped
      else
        local attr = pandoc.Attr("", { "include-banner" }, { ["data-banner-text"] = final_banner_text })
        local wrapper = pandoc.Div(assembled, attr)
        assembled = { wrapper }
      end
    end

    return assembled
  end

  return {
    expand_include_div = expand_include_div,
  }
end

return M
