'use strict';

async function beforeBuild() {
  // Runtime dependencies are bundled or vendored before packaging. Letting
  // electron-builder run an npm production install inside this workspace can
  // prune its own hoisted helper dependencies, including 7zip-bin.
  return false;
}

module.exports = beforeBuild;
module.exports.default = beforeBuild;
