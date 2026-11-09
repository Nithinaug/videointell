package router

import (
	"github.com/gin-gonic/gin"

	"videointell/backend/internal/handlers"
)

type Deps struct {
	VideoHandler *handlers.VideoHandler
	Files        *handlers.FilesHandler
	Auth         gin.HandlerFunc
}

func New(d Deps) *gin.Engine {
	r := gin.Default()
	r.Use(handlers.CORSMiddleware())

	r.GET("/healthz", func(c *gin.Context) { c.JSON(200, gin.H{"status": "ok"}) })

	api := r.Group("/api")
	{

		api.PUT("/files/*key", d.Files.Upload)
		api.GET("/files/*key", d.Files.File)
		api.GET("/results/:exp/:sig/*key", d.Files.Result)

		videos := api.Group("/videos")
		videos.Use(d.Auth)
		{
			videos.POST("", d.VideoHandler.Create)
			videos.GET("", d.VideoHandler.List)
			videos.GET("/:id", d.VideoHandler.Detail)
		}
	}

	return r
}
