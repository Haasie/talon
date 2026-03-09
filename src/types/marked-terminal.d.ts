declare module 'marked-terminal' {
  import type { MarkedExtension } from 'marked';
  function markedTerminal(): MarkedExtension;
  export default markedTerminal;
}
