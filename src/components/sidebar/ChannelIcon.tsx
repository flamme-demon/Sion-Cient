import { HashIcon } from "../icons";

interface ChannelIconProps {
  icon?: string;
}

export function ChannelIcon({ icon }: ChannelIconProps) {
  if (icon) {
    return (
      <img
        src={icon}
        alt=""
        style={{
          width: 18,
          height: 18,
          borderRadius: 6,
          objectFit: 'cover',
          flexShrink: 0,
        }}
      />
    );
  }
  return <HashIcon className="text-text-muted flex-shrink-0" />;
}
