import React from "react";
import { Composition, registerRoot, useCurrentFrame } from "../../../remotion/core/src/index";
import { collection } from "./collection";
import { Artwork } from "./artwork";

function Scene({ id }: { id: string }) {
  const frame = useCurrentFrame();
  return <Artwork work={collection.find(work => work.id === id)!} frame={frame} />;
}
registerRoot(() => (
  <>
    {collection
      .filter(work => work.engine === "remotion")
      .map(work => (
        <Composition
          key={work.id}
          id={work.id}
          component={Scene}
          defaultProps={{ id: work.id }}
          width={work.width}
          height={work.height}
          fps={work.fps.num / work.fps.den}
          durationInFrames={work.durationFrames}
        />
      ))}
  </>
));
