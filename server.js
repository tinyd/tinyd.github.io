const http = require("node:http");
const fs = require("node:fs/promises");
const path = require("node:path");

const root = __dirname;
const port = Number(process.env.PORT || 4173);
const host = process.env.HOST || "127.0.0.1";
const radarBase = "https://gdal.met.ie/api/maps";
const osmBase = "https://tile.openstreetmap.org";
const transparentTile = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"></svg>',
);

const types = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host}`);
    const pathname = decodeURIComponent(url.pathname);

    if (pathname === "/api/radar") {
      await proxyRadarMetadata(response);
      return;
    }

    if (pathname.startsWith("/api/radar-tile/")) {
      await proxyRadarTile(pathname, response);
      return;
    }

    if (pathname.startsWith("/api/osm-tile/")) {
      await proxyOsmTile(pathname, response);
      return;
    }

    const relativePath = pathname === "/" ? "index.html" : pathname.slice(1);
    const filePath = path.resolve(root, relativePath);

    if (!filePath.startsWith(root + path.sep) && filePath !== root) {
      send(response, 403, "Forbidden");
      return;
    }

    const file = await fs.readFile(filePath);
    response.writeHead(200, {
      "Content-Type": types[path.extname(filePath)] || "application/octet-stream",
      "Cache-Control": "no-store",
    });
    response.end(file);
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "EISDIR") {
      send(response, 404, "Not found");
      return;
    }
    console.error(error);
    send(response, 500, "Internal server error");
  }
});

server.listen(port, host, () => {
  console.log(`Rainfall tracker running at http://${host}:${port}`);
});

function send(response, statusCode, message) {
  response.writeHead(statusCode, { "Content-Type": "text/plain; charset=utf-8" });
  response.end(message);
}

async function proxyRadarMetadata(response) {
  const upstream = await fetch(`${radarBase}/radar`, {
    headers: { Accept: "application/json" },
  });

  if (!upstream.ok) {
    send(response, upstream.status, "Radar metadata unavailable");
    return;
  }

  response.writeHead(200, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(Buffer.from(await upstream.arrayBuffer()));
}

async function proxyRadarTile(pathname, response) {
  const parts = pathname.replace("/api/radar-tile/", "").split("/");
  if (parts.length !== 5 || !parts.every((part) => /^\d+$/.test(part))) {
    send(response, 400, "Invalid radar tile path");
    return;
  }

  const [src, x, y, z, mod] = parts;
  const upstream = await fetch(`${radarBase}/radar/${src}/${x}/${y}/${z}/${mod}`, {
    headers: { Accept: "image/png,*/*" },
  });

  if (!upstream.ok) {
    sendTransparentTile(response);
    return;
  }

  const body = Buffer.from(await upstream.arrayBuffer());
  if (body.length === 0) {
    sendTransparentTile(response);
    return;
  }

  response.writeHead(200, {
    "Content-Type": upstream.headers.get("content-type") || "image/png",
    "Cache-Control": "public, max-age=300",
  });
  response.end(body);
}

function sendTransparentTile(response) {
  response.writeHead(200, {
    "Content-Type": "image/svg+xml",
    "Cache-Control": "public, max-age=300",
  });
  response.end(transparentTile);
}

async function proxyOsmTile(pathname, response) {
  const parts = pathname.replace("/api/osm-tile/", "").split("/");
  if (parts.length !== 3 || !parts.every((part) => /^\d+$/.test(part))) {
    send(response, 400, "Invalid map tile path");
    return;
  }

  const [z, x, y] = parts;
  const upstream = await fetch(`${osmBase}/${z}/${x}/${y}.png`, {
    headers: {
      Accept: "image/png,*/*",
      "User-Agent": "rainfall-tracker-local/1.0",
    },
  });

  if (!upstream.ok) {
    sendTransparentTile(response);
    return;
  }

  response.writeHead(200, {
    "Content-Type": upstream.headers.get("content-type") || "image/png",
    "Cache-Control": "public, max-age=86400",
  });
  response.end(Buffer.from(await upstream.arrayBuffer()));
}
