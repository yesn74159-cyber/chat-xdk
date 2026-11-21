const urlPattern = /https?:\/\/[^\s<>]+/g;

export function linkSegments(text) {
  const value = typeof text === "string" ? text : "";
  const segments = [];
  let start = 0;
  for (const match of value.matchAll(urlPattern)) {
    if (match.index > start) segments.push({ type: "text", value: value.slice(start, match.index) });
    segments.push({ type: "link", value: match[0] });
    start = match.index + match[0].length;
  }
  if (start < value.length || !segments.length) segments.push({ type: "text", value: value.slice(start) });
  return segments;
}

export function appendLinkedText(document, container, text) {
  for (const segment of linkSegments(text)) {
    if (segment.type === "text") {
      container.append(document.createTextNode(segment.value));
      continue;
    }
    const anchor = document.createElement("a");
    anchor.href = segment.value;
    anchor.textContent = segment.value;
    anchor.target = "_blank";
    anchor.rel = "noopener noreferrer";
    container.append(anchor);
  }
}
