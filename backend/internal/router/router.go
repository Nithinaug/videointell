package router

import (
	"github.com/gin-gonic/gin"

	"videointell/backend/internal/handlers"
)

type Deps struct {
	VideoHandler *handlers.VideoHandler
	Files        *handlers.FilesHandler
	Ask          *handlers.AskHandler
	Clips        *handlers.ClipHandler
	Shares       *handlers.ShareHandler
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
		api.GET("/share-files/:exp/:sig/*key", d.Files.ShareFile)
		api.GET("/share-view", d.Shares.View)

		videos := api.Group("/videos")
		videos.Use(d.Auth)
		{
			videos.POST("", d.VideoHandler.Create)
			videos.GET("", d.VideoHandler.List)
			videos.GET("/:id", d.VideoHandler.Detail)
			videos.GET("/:id/progress", d.VideoHandler.Progress)
			videos.DELETE("/:id", d.VideoHandler.Delete)
			videos.PATCH("/:id", d.VideoHandler.Rename)
			videos.GET("/:id/clips", d.Clips.List)
			videos.POST("/:id/clips", d.Clips.Create)
			videos.DELETE("/:id/clips/:clip", d.Clips.Delete)
			videos.GET("/:id/shares", d.Shares.List)
			videos.POST("/:id/shares", d.Shares.Create)
			videos.DELETE("/:id/shares/:share", d.Shares.Revoke)
		}
		search := api.Group("/search")
		search.Use(d.Auth)
		{
			search.GET("", d.VideoHandler.Search)
		}
		ask := api.Group("/ask")
		ask.Use(d.Auth)
		{
			ask.POST("", d.Ask.Ask)
		}
	}

	return r
}
