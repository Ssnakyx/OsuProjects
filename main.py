import sys
import pygame
from src.renderer import Renderer


def main() -> None:
    pygame.init()
    screen = pygame.display.set_mode((1280, 720), pygame.RESIZABLE)
    pygame.display.set_caption("osu! Replay Viewer")

    renderer = Renderer(screen)
    clock    = pygame.time.Clock()

    while True:
        for event in pygame.event.get():
            if event.type == pygame.QUIT:
                pygame.quit()
                sys.exit()

            elif event.type == pygame.DROPFILE:
                renderer.handle_drop(event.file)

            elif event.type == pygame.KEYDOWN:
                if event.key == pygame.K_ESCAPE:
                    pygame.quit()
                    sys.exit()
                elif event.key == pygame.K_SPACE:
                    renderer.toggle_pause()
                elif event.key == pygame.K_r:
                    renderer.restart()
                elif event.key == pygame.K_TAB:
                    renderer.toggle_mode()
                elif event.key == pygame.K_LEFT:
                    renderer.seek(-5000)
                elif event.key == pygame.K_RIGHT:
                    renderer.seek(5000)

            elif event.type == pygame.VIDEORESIZE:
                screen = pygame.display.set_mode(event.size, pygame.RESIZABLE)
                renderer.screen = screen

        renderer.update()
        renderer.draw()
        pygame.display.flip()
        clock.tick(60)


if __name__ == "__main__":
    main()
