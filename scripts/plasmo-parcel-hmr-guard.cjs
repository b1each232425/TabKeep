const Module = require("module")
const fs = require("fs")
const path = require("path")

const originalLoader = Module._extensions[".js"]
const marker = "TabKeep: tolerate early HMR requests"
const needle =
  "let id = pathname.slice($72cb83cccfeadd0f$var$HMR_ENDPOINT.length + 1);"
const replacement = `if (this.bundleGraph == null) {
                // ${marker} on newer Node versions.
                res.statusCode = 503;
                res.end("");
                return true;
            }
            let id = pathname.slice($72cb83cccfeadd0f$var$HMR_ENDPOINT.length + 1);`

Module._extensions[".js"] = function loadWithPlasmoGuard(module, filename) {
  const normalized = filename.split(path.sep).join("/")
  const isParcelDevServer =
    normalized.includes("@parcel/reporter-dev-server/lib/ServerReporter.js") ||
    normalized.includes("@parcel+reporter-dev-server") &&
      normalized.endsWith("/@parcel/reporter-dev-server/lib/ServerReporter.js")

  if (!isParcelDevServer) {
    return originalLoader(module, filename)
  }

  let source = fs.readFileSync(filename, "utf8")
  if (!source.includes(marker) && source.includes(needle)) {
    source = source.replace(needle, replacement)
  }

  return module._compile(source, filename)
}
