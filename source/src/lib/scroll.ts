/** Find the scrolling viewport even before its first content has been laid out. */
export function scrollParentOf(element:HTMLElement|null):HTMLElement|null {
  let parent=element?.parentElement??null;
  while(parent && parent!==document.body) {
    if(/(auto|scroll|overlay)/.test(getComputedStyle(parent).overflowY)) return parent;
    parent=parent.parentElement;
  }
  const root=document.scrollingElement??document.documentElement;
  return root instanceof HTMLElement?root:null;
}

/** A margin on the document cannot extend an intermediate overflow clip. */
export function intersectionRootOf(element:HTMLElement|null):HTMLElement|null {
  const parent=scrollParentOf(element);
  return parent===document.scrollingElement || parent===document.documentElement?null:parent;
}
